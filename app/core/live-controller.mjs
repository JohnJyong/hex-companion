import { canEquip, interactionLabel, rankCandidates, recommendBuilds } from './engine.mjs';
import { parseLiveGame } from './live-game.mjs';
import { applyObservation, chooseAugment, emptySession, validateSession } from './session.mjs';
import { createRecognitionTracker } from './recognition.mjs';

const FULL_FRAME = { x: 0, y: 0, width: 1, height: 1 };
const FRESH_MS = 8000, REVIEW_MS = 1500;
const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);
const message = error => String(error?.message || error || '未知错误');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sourceKey = frame => `${frame?.windowId ?? ''}:${frame?.width}:${frame?.height}`;
const fingerprint = (event, frame) => frame?.fingerprint ?? event?.fingerprint ?? null;
const validBounds = b => b && ['x', 'y', 'width', 'height'].every(key => finite(b[key])) && b.width > 0 && b.height > 0;
const pausedError = error => error?.category === 'paused'
  || /WAIT_FOREGROUND|WINDOW_(NOT_FOREGROUND|MINIMIZED|MOVING|OFFSCREEN)/.test(error?.code || '')
  || /不在前台|最小化|屏幕外|正在移动/.test(message(error));

/** Coordinates capture evidence with a session; never sends input to the game. */
export function createLiveController({ desktop, db, getState, commit, onChange = () => {}, toast = () => {}, now = Date.now }) {
  if (typeof getState !== 'function' || typeof commit !== 'function') throw new TypeError('需要对局读取与提交函数');
  // Capture returns full-client coordinates, even when OCR used a cropped strip.
  const tracker = createRecognitionTracker(db, { roi: FULL_FRAME });
  const view = {
    active: false, busy: false, status: '自动识别未启动', error: null,
    frameText: '', lastFrameAt: null, lastAcceptedAt: null, windowTitle: '', gameConnected: false,
    phase: 'idle', actionable: false, metrics: null, errorCode: null, evidenceId: null, roiHint: null, confirmationPending: false,
  };
  let generation = 0, subscriptions = [], commandQueue = Promise.resolve();
  let shown = null, proof = null, reviewUntil = null, missingFrames = 0;
  let lastGameTime = null, expiryTimer = null, syncItems = true;
  let runStartedAt = 0, expectedWindowId = '', foreground = true;
  let targetIsGame = false, panelChampion = null, lastLiveHero = null, buildKey = '', cachedBuild = null;

  function detach() {
    for (const unsubscribe of subscriptions) if (typeof unsubscribe === 'function') unsubscribe();
    subscriptions = [];
  }
  function clearEvidence() {
    tracker.reset(); shown = null; proof = null; reviewUntil = null; missingFrames = 0;
    view.actionable = false; view.phase = 'idle'; view.lastAcceptedAt = null;
    view.evidenceId = null;
    view.roiHint = null;
    view.confirmationPending = false;
    clearTimeout(expiryTimer); expiryTimer = null;
  }
  function snapshot() {
    const state = getState(), age = view.lastFrameAt === null ? Infinity : now() - view.lastFrameAt;
    const stateMatches = shown?.confirmed ? sameIds(state.candidates, shown.ids) : true;
    const lifetime = view.phase === 'review' ? reviewUntil !== null && now() <= reviewUntil : age >= 0 && age <= FRESH_MS;
    const display = Boolean(view.active && foreground && shown && lifetime && stateMatches && view.phase !== 'suspended');
    const actionable = Boolean(display && view.actionable && view.phase === 'confirmed' && proof && sameIds(state.candidates, proof.ids));
    return {
      ...view, fresh: actionable, actionable, display,
      phase: !display && view.phase !== 'suspended' ? 'idle' : view.phase,
      displayCandidates: display ? [...shown.ids] : [], displayTier: display ? shown.tier : null,
      confirmed: Boolean(display && shown.confirmed), layout: display ? structuredClone(shown.layout) : null,
      roiHint: view.active && foreground && view.roiHint ? structuredClone(view.roiHint) : null,
      status: shown && !display && view.phase !== 'suspended' ? '候选已过期或已变更，等待画面确认' : view.status,
    };
  }
  function changed() { onChange(snapshot()); }
  function equipmentFor(state, champion) {
    const recentHero = lastLiveHero && lastLiveHero.id === champion?.id && now() - lastLiveHero.at <= 3200;
    if (!champion || state.demo || !view.active || !foreground || view.phase === 'suspended'
      || !(targetIsGame && recentHero || panelChampion === champion.id)) return null;
    // Gold and OCR heartbeats change frequently; neither changes purchase order.
    const key = JSON.stringify([champion.id, state.selected, state.owned, state.strategy, state.priority, state.enemy]);
    if (key !== buildKey) {
      const plan = recommendBuilds(state, db)[0];
      cachedBuild = plan ? {
        hero: champion.name, route: plan.name, reason: plan.nextReason, selected: state.selected.map(id => db.augmentMap.get(id).name),
        complete: state.owned.length === 6,
        purchases: plan.items.filter(item => !state.owned.includes(item.id)).slice(0, 3)
          .map(({ id, name, cost }) => ({ id, name, cost })),
      } : null;
      buildKey = key;
    }
    return cachedBuild;
  }
  function publish() {
    const current = snapshot(), state = getState();
    const champion = db.championMap.get(state.championId);
    const ranking = current.display && current.confirmed
      ? rankCandidates({ ...state, candidates: shown.ids, tier: shown.tier }, db) : [];
    const scores = new Map(ranking.map(item => [item.augment.id, item]));
    const leader = ranking[0];
    const bestId = leader && !leader.conflict && (Number.isFinite(leader.score) || leader.statistics?.reliable) ? leader.augment.id : null;
    const build = equipmentFor(state, champion), nextItem = build?.purchases[0];
    const payload = {
      hero: champion?.name || '等待识别英雄', status: current.status,
      display: current.display, actionable: current.actionable, phase: current.phase,
      timestamp: current.lastFrameAt, lastAcceptedAt: current.lastAcceptedAt, layout: current.layout,
      evidenceId: current.evidenceId,
      roiHint: current.roiHint,
      confirmationPending: current.confirmationPending,
      cards: current.display ? shown.ids.map((id, slot) => {
        const score = scores.get(id);
        return {
          id, name: db.augmentMap.get(id)?.name || '', tier: db.augmentMap.get(id)?.tier || '', score: score?.score ?? null,
          slot, best: current.actionable && id === bestId,
          statistics: score?.statistics ? { ...score.statistics } : null,
          reason: score?.reasons?.slice(0, 2).join(' ') || '', warning: score?.warnings?.slice(0, 2).join(' ') || '',
          conflict: score?.conflict === true,
          interaction: interactionLabel(score?.interactions?.[0]),
          guide: score?.guide ? `攻略提及 · ${score.guide.partners.join('、')}` : '',
          rankingBasis: score?.rankingBasis || '',
          pending: !current.actionable, actionable: current.actionable,
        };
      }) : [],
      build,
      next: nextItem ? `${nextItem.name} · ${nextItem.cost} 金币` : '',
    };
    if (typeof desktop?.updateOverlay === 'function') {
      const token = generation;
      const failed = error => {
        if (token !== generation || !view.active) return;
        view.error = `悬浮窗更新失败：${message(error)}`; changed();
      };
      try { Promise.resolve(desktop.updateOverlay(payload)).catch(failed); } catch (error) { failed(error); }
    }
    return payload;
  }
  function refresh() { changed(); publish(); }
  function armExpiry() {
    clearTimeout(expiryTimer);
    if (!shown) return;
    const until = view.phase === 'review' ? reviewUntil : view.lastFrameAt + FRESH_MS;
    const token = generation;
    expiryTimer = setTimeout(() => {
      if (token !== generation || !view.active) return;
      if (!snapshot().display) {
        clearEvidence(); view.status = view.error || '等待新的三选一画面'; refresh();
      } else armExpiry();
    }, Math.max(1, until - now() + 1));
    expiryTimer?.unref?.();
  }
  function review(status) {
    view.actionable = false; view.status = status; view.confirmationPending = false;
    if (shown?.confirmed && (reviewUntil === null || now() <= reviewUntil)) {
      if (reviewUntil === null) reviewUntil = now() + REVIEW_MS;
      view.phase = 'review';
    } else {
      shown = null; proof = null; reviewUntil = null; view.phase = 'idle';
    }
    armExpiry();
  }
  function applyGame(game) {
    const live = parseLiveGame(game, db);
    view.gameConnected = live !== null;
    if (!live) {
      const mode = game?.gameData?.gameMode;
      if (mode && !['KIWI', 'ARAM'].includes(mode)) { lastLiveHero = null; panelChampion = null; }
      return;
    }
    // Some clients report plain ARAM for both modes. In that case a confirmed
    // three-card row is the visual evidence that the Mayhem build applies.
    lastLiveHero = game.gameData.gameMode === 'KIWI' ? {id:live.championId, at:now()} : null;
    const previous = getState();
    const rolledBack = live.gameTime !== null && lastGameTime !== null && live.gameTime < lastGameTime - 15;
    const newGame = previous.demo === true || previous.championId !== live.championId || rolledBack;
    let next = newGame ? { ...emptySession(), championId: live.championId } : previous;
    if (newGame) { clearEvidence(); panelChampion = null; }
    const champion = db.championMap.get(live.championId);
    const refreshInventory = syncItems && !live.inventoryMissing;
    const owned = refreshInventory ? [] : [...next.owned];
    if (refreshInventory) for (const id of live.owned) if (canEquip(id, owned, champion, db)) owned.push(id);
    const gold = syncItems ? live.gold ?? next.gold : next.gold;
    if (newGame || !sameIds(next.owned, owned) || next.gold !== gold) {
      next = validateSession({ ...next, championId: live.championId, owned, gold, demo: false }, db); commit(next);
    }
    if (live.gameTime !== null) lastGameTime = live.gameTime;
  }
  function layoutFor(frame, matches) {
    return { width: frame.width, height: frame.height, bounds: validBounds(frame.bounds) ? { ...frame.bounds } : null,
      boxes: matches.map((match, slot) => ({ ...match.box, slot })) };
  }
  function capture(event, token) {
    if (token !== generation || !view.active) return;
    if (finite(event?.timestamp) && event.timestamp < runStartedAt) return;
    const frame = event?.frame || event;
    if (frame?.windowId !== undefined && expectedWindowId && String(frame.windowId) !== expectedWindowId) return;
    try {
      if (event?.metrics) view.metrics = { ...event.metrics };
      if (event?.error?.code) view.errorCode = event.error.code;
      if (event?.frame && !event.error) view.errorCode = null;
      if (event?.type === 'record-blocked') { toast(event.reason || '画面正在复核，请稍后再记录'); return; }
      if (event?.type === 'diagnostic') { view.error = message(event.error); view.status = `快捷键检测异常：${view.error}，可用主窗口按钮隐藏`; changed(); return; }
      if (Object.hasOwn(event || {}, 'game')) applyGame(event.game);
      if (event?.type === 'game') { refresh(); return; }
      if (event?.type === 'window-state') {
        if (event.foreground === foreground) return;
        if (event.foreground === false) {
          foreground = false; clearEvidence(); view.phase = 'suspended';
          view.status = event.message || event.windowState?.message || '游戏窗口不在前台，识别已暂停';
        } else if (event.foreground === true && !foreground) {
          foreground = true; clearEvidence(); view.error = null; view.status = '已切回游戏，等待新的画面确认';
        }
        refresh(); return;
      }
      if (!foreground) return;
      if (event?.panelVisible === false || frame?.panelVisible === false || event?.type === 'panel-gone') {
        clearEvidence(); view.error = null; view.status = '三选一面板已关闭，等待下一轮'; refresh(); return;
      }
      if (event?.error) {
        tracker.ingest(null); // Break a pending OCR streak without discarding the display grace.
        view.roiHint = null; view.confirmationPending = false;
        view.error = message(event.error);
        if (pausedError(event.error)) {
          clearEvidence(); view.phase = 'suspended'; view.status = `识别已暂停：${view.error}`;
        } else if (event.error.transient === false) { clearEvidence(); view.status = view.error; }
        else review(`等待复核：${view.error}`);
        refresh(); return;
      }
      if (event?.type === 'frame-changed') {
        view.error = null; review('画面已变化，正在复核候选'); refresh(); return;
      }
      if (event?.type === 'heartbeat') {
        // An unchanged fingerprint is continuity evidence, never another OCR vote.
        if (proof && view.phase === 'confirmed' && view.actionable && sourceKey(frame) === proof.source
          && fingerprint(event, frame) !== null && fingerprint(event, frame) === proof.fingerprint && snapshot().actionable) {
          view.lastFrameAt = finite(event.timestamp) ? Math.min(now(), event.timestamp) : now();
          if (validBounds(frame.bounds)) shown.layout.bounds = { ...frame.bounds };
          view.error = null; armExpiry();
        }
        refresh(); return;
      }
      if (!event?.frame) { review('等待可识别的游戏画面'); refresh(); return; }
      if (shown && sourceKey(frame) !== shown.source) clearEvidence();
      view.evidenceId = event.evidenceId ?? null;
      view.error = null; view.frameText = typeof frame.text === 'string' ? frame.text.slice(0, 12000) : '';
      const evidence = tracker.ingest(frame);
      if (evidence.status === 'duplicate-frame') { refresh(); return; }
      const hint = ['stable', 'unchanged', 'stabilizing'].includes(evidence.status) ? layoutFor(frame, evidence.matches) : null;
      view.roiHint = hint; view.confirmationPending = false;
      if (evidence.code !== 'geometry-required') view.lastFrameAt = finite(event.timestamp) ? Math.min(now(), event.timestamp) : now();
      const state = getState();
      if (!state.championId || state.demo) {
        clearEvidence();
        view.roiHint = hint;
        view.status = state.demo ? '等待识别实际英雄，演示对局不会用于实时建议' : '等待本地接口识别英雄，或手动选择英雄';
      } else if (['stable', 'unchanged', 'stabilizing'].includes(evidence.status)) {
        missingFrames = 0;
        if (evidence.candidates.some(id => state.selected.includes(id))) {
          clearEvidence(); view.evidenceId = event.evidenceId ?? null;
          view.status = '当前面板的选择已经记录，等待下一轮'; refresh(); return;
        }
        const row = { ids: [...evidence.candidates], tier: evidence.tier, source: sourceKey(frame),
          fingerprint: fingerprint(event, frame), layout: layoutFor(frame, evidence.matches), confirmed: false };
        if (shown && !sameIds(shown.ids, row.ids)) { shown = null; proof = null; reviewUntil = null; view.lastAcceptedAt = null; }
        if (evidence.status === 'stable' || (evidence.status === 'unchanged' && sameIds(state.candidates, row.ids))) {
          if (evidence.observation) commit(applyObservation(state, evidence.observation, db));
          shown = { ...row, confirmed: true }; proof = { ...shown }; reviewUntil = null;
          panelChampion = state.championId;
          view.lastAcceptedAt = view.lastFrameAt; view.actionable = true; view.phase = 'confirmed';
          view.status = '本轮候选已确认 · Ctrl+Alt+1/2/3 记录选择';
        } else if (shown?.confirmed && sameIds(shown.ids, row.ids)) {
          review(`正在复核本轮候选（${evidence.stableCount}/${evidence.requiredFrames}）`);
        } else {
          proof = null; reviewUntil = null; view.actionable = false;
          shown = evidence.code === 'exact-row' ? row : null;
          view.phase = shown ? 'preview' : 'idle';
          view.status = `正在确认本轮候选（${evidence.stableCount}/${evidence.requiredFrames}）`;
        }
        view.confirmationPending = evidence.status === 'stabilizing';
      } else {
        if (evidence.status === 'no-panel') missingFrames++; else missingFrames = 0;
        if (missingFrames >= 2) { clearEvidence(); view.status = '连续画面未见三选一面板，等待下一轮'; }
        else review(evidence.status === 'no-panel' ? '本帧未读到候选，短暂等待复核' : `等待复核：${evidence.reason}`);
      }
      // A current negative OCR verdict is still useful to the capture scheduler;
      // it can widen the region without treating this as candidate evidence.
      view.evidenceId = event.evidenceId ?? null;
      armExpiry(); refresh();
    } catch (error) { clearEvidence(); view.error = message(error); view.status = `识别结果需核对：${view.error}`; refresh(); }
  }
  function record(slot, token) {
    if (token !== generation || !view.active || !Number.isInteger(slot) || slot < 0 || slot > 2) return;
    if (!snapshot().actionable) { toast('候选正在复核，请确认画面稳定后再记录'); refresh(); return; }
    try {
      const state = getState(), id = state.candidates[slot], next = chooseAugment(state, id, db);
      clearEvidence(); view.status = `已记录「${db.augmentMap.get(id).name}」，等待下一轮`;
      commit(next); refresh(); toast(`已记录「${db.augmentMap.get(id).name}」`);
    } catch (error) {
      clearEvidence(); view.error = message(error); view.status = '选择未记录，请核对当前对局'; refresh(); toast(view.error);
    }
  }
  function enqueue(action) {
    const command = commandQueue.then(action); commandQueue = command.catch(() => {}); return command;
  }
  async function start(options = {}) {
    const token = ++generation;
    detach(); clearEvidence(); lastGameTime = null; foreground = true; panelChampion = null; lastLiveHero = null; targetIsGame = false;
    syncItems = options.syncItems !== false; expectedWindowId = String(options.windowId ?? '');
    Object.assign(view, { active: false, busy: true, error: null, frameText: '', lastFrameAt: null,
      gameConnected: false, status: '正在启动自动识别', windowTitle: options.windowTitle || options.title || '' });
    changed();
    try {
      if (!desktop?.captureStart || !desktop?.onCapture || !desktop?.onRecord) throw new Error('自动识别需要 Windows 桌面版本');
      subscriptions = [desktop.onCapture(event => capture(event, token)), desktop.onRecord(slot => record(slot, token))];
      const result = await enqueue(() => token === generation ? desktop.captureStart(options) : null);
      if (token !== generation) return null;
      targetIsGame = result?.window?.isGame === true || result?.window?.processName === 'League of Legends';
      runStartedAt = now(); view.active = true; view.busy = false;
      view.windowTitle = result?.window?.title || view.windowTitle; view.status = '自动识别已启动，等待游戏画面'; refresh(); return result;
    } catch (error) {
      if (token !== generation) return null;
      detach(); clearEvidence(); Object.assign(view, { active: false, busy: false, error: message(error), status: '自动识别启动失败' });
      refresh(); throw error;
    }
  }
  async function stop() {
    const token = ++generation;
    detach(); clearEvidence(); lastGameTime = null; panelChampion = null; lastLiveHero = null; targetIsGame = false;
    Object.assign(view, { active: false, busy: true, gameConnected: false, error: null, status: '自动识别已停止',
      frameText: '', lastFrameAt: null, windowTitle: '' });
    refresh();
    try { await enqueue(() => desktop?.captureStop?.()); }
    catch (error) { if (token === generation) view.error = message(error); }
    finally { if (token === generation) { view.busy = false; changed(); } }
    return snapshot();
  }
  function reset({keepMatch = false} = {}) {
    clearEvidence();
    if (!keepMatch) { lastGameTime = null; panelChampion = null; lastLiveHero = null; }
    Object.assign(view, { frameText: '', lastFrameAt: null, error: null, status: view.active ? '等待新的画面确认' : '自动识别未启动' });
    refresh(); return snapshot();
  }
  return { start, stop, snapshot, reset, publish };
}
