// Resolve only the active player's identity, never the first or a random player.
export function parseLiveGame(payload, db) {
  if (!payload?.activePlayer || !Array.isArray(payload.allPlayers)) return null;
  // A missing mode is not evidence of ARAM: do not overwrite the user's session
  // using a partial loading-screen response or a different game mode.
  if (!['ARAM', 'KIWI'].includes(payload.gameData?.gameMode)) return null;
  const active = payload.activePlayer;
  const text = value => typeof value === 'string' ? value.trim() : '';
  // Riot ID includes the tag and takes precedence over the legacy name. Never
  // fall back to a same-name player when a supplied Riot ID cannot be resolved.
  const identityKey = text(active.riotId) ? 'riotId' : 'summonerName';
  const identity = text(active[identityKey]);
  if (!identity) return null;
  const players = payload.allPlayers.filter(p => p && text(p[identityKey]) === identity);
  if (players.length !== 1) return null;
  const player = players[0];
  // The stable raw key is authoritative when supplied. Display names are a
  // fallback only when the client omitted it; unknown raw keys stay unknown.
  const rawName = text(player.rawChampionName);
  const key = (rawName || text(player.championName)).replace(/^game_character_displayname_/i, '');
  if (!key) return null;
  const matches = db.champions.filter(c => c.id.toLowerCase() === key.toLowerCase() || c.name === key || c.title === key);
  if (matches.length !== 1) return null;
  const items = Array.isArray(player.items) ? player.items : [];
  const evolved = { '3040': '3003', '3042': '3004', '3121': '3119' };
  const owned = items.filter(item => item && (
    (typeof item.itemID === 'number' && Number.isSafeInteger(item.itemID) && item.itemID > 0) ||
    (typeof item.itemID === 'string' && /^[1-9][0-9]*$/.test(item.itemID))
  )).map(item => String(item.itemID)).map(id => evolved[id] || id).filter(id => db.itemMap.has(id));
  return {
    championId: matches[0].id,
    // The catalog contains completed items; components and consumables are not
    // promoted to completed equipment or inferred from purchase cost.
    owned: [...new Set(owned)].slice(0, 6),
    ...(!Array.isArray(player.items) ? {inventoryMissing: true} : {}),
    gold: Number.isFinite(active.currentGold) ? Math.max(0, Math.min(99999, Math.floor(active.currentGold))) : null,
    gameTime: Number.isFinite(payload.gameData.gameTime) && payload.gameData.gameTime >= 0 ? payload.gameData.gameTime : null,
  };
}
