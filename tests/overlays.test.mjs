import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCardOverlays } = require('../desktop/overlays.cjs');

const payload = (y = 900) => ({ hero: '亚索', phase: 'confirmed', display: true, actionable: true,
  layout: { width: 2560, height: 1440, bounds: { x: 100, y: 200, width: 2560, height: 1440 },
    boxes: [560, 1200, 1840].map(x => ({ x, y, width: 160, height: 40 })) },
  cards: [0, 1, 2].map(slot => ({ slot, name: `候选${slot + 1}`, score: 70 + slot,
    statistics: { winRate: .55, games: 12000, deltaPP: 2.5, tierRank: 3, tierCount: 50, grade: 'S' } })) });

function harness(scale = 1) {
  const windows = [], conversions = [], visibility = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options; this.visible = false; this.destroyed = false;
      this.shows = 0; this.hides = 0; this.messages = []; this.boundsHistory = [];
      this.webContents = new EventEmitter();
      this.webContents.isLoading = () => false;
      this.webContents.send = (channel, message) => this.messages.push({ channel, message });
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setContentProtection(value) { this.contentProtection = value; }
    setIgnoreMouseEvents(value, options) { this.ignoreMouse = { value, options }; }
    setAlwaysOnTop(value, level) { this.topmost = { value, level }; }
    loadFile(path) { this.path = path; }
    setBounds(bounds) { this.bounds = bounds; this.boundsHistory.push(bounds); }
    showInactive() { this.visible = true; this.shows++; }
    hide() { this.visible = false; this.hides++; }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  const manager = createCardOverlays({ BrowserWindow: FakeBrowserWindow,
    screen: { screenToDipRect(window, rectangle) { conversions.push({ window, rectangle });
      return Object.fromEntries(Object.entries(rectangle).map(([key, value]) => [key, value / scale])); } },
    preloadPath: '/local/preload.cjs', htmlPath: '/local/overlay.html', platform: 'win32',
    onVisibility: state => visibility.push(state),
  });
  return { manager, windows, conversions, visibility };
}

test('equipment stays on the target client without OCR, follows Windows DPI, and hides with the cards', () => {
  const h = harness(1.5);
  const bounds = {x:-2560, y:120, width:2560, height:1440};
  h.manager.setGameVisible(true, {bounds});
  const build = {hero:'亚索', route:'暴击持续输出', complete:false, selected:['升级：无尽之刃'],
    purchases:[{id:'3031',name:'无尽之刃',cost:3500}]};
  const idle = {display:false,phase:'idle',cards:[],layout:null,build};
  h.manager.update(idle);
  const panel = h.windows[0];
  assert.ok(panel.path.endsWith('build-overlay.html'));
  assert.ok(panel.visible && !panel.options.focusable && panel.ignoreMouse.value);
  assert.ok(panel.bounds.x < 0 && panel.bounds.x + panel.bounds.width < 0, 'anchors to the negative-origin monitor');
  const position = panel.bounds;
  for (let i = 0; i < 5; i++) {
    h.manager.setGameVisible(true, {bounds:{...bounds}});
    h.manager.update(idle);
  }
  assert.equal(panel.messages.length, 1);
  assert.equal(panel.boundsHistory.length, 1);
  h.manager.setGameVisible(true, {bounds:{...bounds,x:0}});
  assert.ok(panel.bounds.x > position.x && panel.bounds.width === position.width);
  h.manager.update({...payload(),build});
  assert.equal(h.windows.filter(w => w.visible).length, 4);
  h.manager.update(idle);
  assert.deepEqual(h.windows.filter(w => w.visible), [panel]);
  h.manager.toggle(); h.manager.update(idle);
  assert.ok(h.windows.every(w => !w.visible));
  h.manager.setGameVisible(false); h.manager.toggle(); h.manager.setGameVisible(true);
  assert.ok(!panel.visible, 'foreground alone must not reuse an old monitor rectangle');
  h.manager.setGameVisible(true,{bounds});
  assert.ok(panel.visible);
  h.manager.update({...idle,build:{...build,purchases:[{id:'../other',name:'bad',cost:1}]}});
  assert.ok(!panel.visible);
  h.manager.clear(); h.manager.update(idle);
  assert.ok(!panel.visible);
  h.manager.destroy();
});

for (const scale of [1, 1.5]) test(`three labels align above 1440p cards at ${scale * 100}% display scaling`, () => {
  const h = harness(scale); h.manager.setGameVisible(true); h.manager.update(payload());
  assert.equal(h.windows.length, 3);
  const expectedPhysical = [471, 1111, 1751].map(x => ({ x, y: 913, width: 538, height: 151 }));
  assert.deepEqual(h.conversions.map(call => call.rectangle), expectedPhysical,
    'each label must be centered over its actual title in physical screen coordinates');
  for (let slot = 0; slot < 3; slot++) {
    const w = h.windows[slot];
    assert.deepEqual(w.bounds, Object.fromEntries(Object.entries(expectedPhysical[slot]).map(([key, value]) => [key, Math.round(value / scale)])));
    assert.equal(w.messages.at(-1).message.card.slot, slot);
    assert.equal(w.messages.at(-1).message.card.statistics.winRate, .55);
    assert.equal(w.options.focusable, false);
    assert.equal(w.options.skipTaskbar, true);
    assert.equal(w.ignoreMouse.value, true, 'card annotations must not intercept the game click');
    assert.equal(w.contentProtection, true, 'do not recognize the assistant annotations as game text');
    assert.equal(w.shows, 1);
  }
  h.manager.destroy();
});

test('label positions follow a moved title row instead of a fixed screen percentage', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload(900));
  const originalY = h.windows.map(window => window.bounds.y);
  h.manager.update(payload(450));
  assert.deepEqual(h.windows.map(window => window.bounds.y), originalY.map(y => y - 450));
  assert.ok(h.windows.every(window => window.shows === 1), 'moving live labels must not hide and reshow them');
  h.manager.destroy();
});

test('H-hidden overlays stay hidden across updates and foreground transitions until toggled again', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload());
  assert.deepEqual(h.manager.toggle(), { enabled: false, visible: false });
  for (let i = 0; i < 5; i++) h.manager.update(payload());
  h.manager.setGameVisible(false); h.manager.setGameVisible(true);
  assert.equal(h.manager.state().visible, false);
  assert.ok(h.windows.every(window => window.shows === 1));
  assert.deepEqual(h.manager.toggle(), { enabled: true, visible: true });
  assert.ok(h.windows.every(window => window.shows === 2));
  h.manager.destroy();
});

test('foreground loss, suspended display and invalid layouts remove all old labels', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload());
  h.manager.setGameVisible(false); h.manager.update(payload());
  assert.equal(h.manager.state().visible, false);
  h.manager.setGameVisible(true);
  assert.equal(h.manager.state().visible, true);
  h.manager.update({ ...payload(), phase: 'suspended' });
  assert.equal(h.manager.state().visible, false);
  h.manager.update(payload());
  const invalid = payload(); invalid.layout.boxes[1].x = 3000;
  h.manager.update(invalid);
  assert.equal(h.manager.state().visible, false, 'invalid current geometry must not leave old labels onscreen');
  assert.ok(h.windows.every(window => !window.visible));
  h.manager.destroy();
});

test('repeated fresh recommendations update text without repeatedly showing windows', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload());
  for (let i = 0; i < 20; i++) {
    const next = payload(); next.cards[0].score = i; next.cards[0].name = `新候选${i}`;
    h.manager.update(next);
  }
  assert.equal(h.windows.length, 3, 'reuse the three labels');
  assert.ok(h.windows.every(window => window.shows === 1));
  assert.equal(h.windows[0].messages.at(-1).message.card.name, '新候选19');
  assert.equal(h.windows[0].messages.at(-1).message.card.score, 19);
  assert.equal(h.windows[0].messages.length, 21);
  assert.deepEqual(h.windows.map(w => w.messages.length), [21, 1, 1], 'only the changed card receives new content');
  assert.deepEqual(h.windows.map(w => w.boundsHistory.length), [1, 1, 1], 'stable positions require no more native window moves');
  h.manager.destroy();
});

test('idle heartbeats produce no redraw and page reload replays the current recommendation', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload());
  const notifications = h.visibility.length;
  for (let i = 0; i < 16; i++) h.manager.update(payload());
  assert.deepEqual(h.windows.map(w => w.messages.length), [1, 1, 1]);
  assert.equal(h.visibility.length, notifications);
  h.windows[1].webContents.emit('did-stop-loading');
  assert.deepEqual(h.windows.map(w => w.messages.length), [1, 2, 1]);
  assert.equal(h.windows[1].messages.at(-1).message.card.name, '候选2');
  h.manager.destroy();
});

test('a late page-load event cannot bring a hidden label back', () => {
  const h = harness(); h.manager.setGameVisible(true); h.manager.update(payload());
  h.manager.toggle();
  for (const window of h.windows) window.webContents.emit('did-stop-loading');
  assert.equal(h.manager.state().visible, false);
  assert.ok(h.windows.every(window => window.shows === 1));
  h.manager.destroy();
});
