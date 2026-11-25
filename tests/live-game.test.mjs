import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLiveGame } from '../app/core/live-game.mjs';
import { indexCatalog, recommendBuilds } from '../app/core/engine.mjs';
import { emptySession } from '../app/core/session.mjs';

const db = indexCatalog(JSON.parse(await readFile(new URL('../app/data/catalog.json', import.meta.url), 'utf8')));
const player = (extra = {}) => ({
  riotId: '当前玩家#CN1', summonerName: '当前玩家', rawChampionName: 'game_character_displayname_Ahri',
  championName: '阿狸', items: [], ...extra,
});
const game = (extra = {}) => ({
  activePlayer: { riotId: '当前玩家#CN1', summonerName: '当前玩家', currentGold: 1520.75 },
  allPlayers: [player()], gameData: { gameMode: 'KIWI', gameTime: 120.5 }, ...extra,
});

test('resolves the active player even when another player is first', () => {
  const payload = game({ allPlayers: [player({ riotId: '其他玩家#CN1', summonerName: '其他玩家', rawChampionName: 'game_character_displayname_Jinx', items: [{ itemID: 3031 }] }), player({ items: [{ itemID: 3089 }] })] });
  assert.deepEqual(parseLiveGame(payload, db), { championId: 'Ahri', owned: ['3089'], gold: 1520, gameTime: 120.5 });
});

test('Riot ID wins over a legacy name shared by a different player', () => {
  const payload = game({ allPlayers: [player({ riotId: '别人#CN2', rawChampionName: 'game_character_displayname_Jinx' }), player()] });
  assert.equal(parseLiveGame(payload, db).championId, 'Ahri');
});

test('an unmatched or duplicate Riot ID never falls back to a summoner name', () => {
  assert.equal(parseLiveGame(game({ allPlayers: [player({ riotId: '别人#CN2' })] }), db), null);
  assert.equal(parseLiveGame(game({ allPlayers: [player(), player({ summonerName: '另一个旧名' })] }), db), null);
});

test('legacy clients without Riot ID require a unique summoner name', () => {
  const activePlayer = { summonerName: '当前玩家', currentGold: 0 };
  assert.equal(parseLiveGame(game({ activePlayer }), db).championId, 'Ahri');
  assert.equal(parseLiveGame(game({ activePlayer, allPlayers: [player(), player({ riotId: '别人#CN2' })] }), db), null);
  assert.equal(parseLiveGame(game({ activePlayer: { currentGold: 4000 } }), db), null);
});

test('unrelated players and malformed player entries cannot supply a hero', () => {
  assert.equal(parseLiveGame(game({ allPlayers: [null, {}, 1, player({ riotId: '别人#CN2', summonerName: '其他玩家' })] }), db), null);
  assert.equal(parseLiveGame(game({ allPlayers: [null, {}, 1, player()] }), db).championId, 'Ahri');
});

test('recognizes stable champion keys with localized names and raw Chinese names', () => {
  for (const rawChampionName of ['game_character_displayname_Ahri', 'GAME_CHARACTER_DISPLAYNAME_ahri', '阿狸', '九尾妖狐']) {
    assert.equal(parseLiveGame(game({ allPlayers: [player({ rawChampionName, championName: 'untranslated' })] }), db).championId, 'Ahri');
  }
});

test('missing raw champion key can fall back to an exact Chinese name or title', () => {
  for (const championName of ['阿狸', '九尾妖狐', 'Ahri']) {
    assert.equal(parseLiveGame(game({ allPlayers: [player({ rawChampionName: undefined, championName })] }), db).championId, 'Ahri');
  }
});

test('unknown raw champion keys do not borrow another hero display name', () => {
  for (const extra of [{ rawChampionName: 'game_character_displayname_Unknown', championName: '阿狸' }, { rawChampionName: null, championName: '未知英雄' }, { rawChampionName: null, championName: '' }]) {
    assert.equal(parseLiveGame(game({ allPlayers: [player(extra)] }), db), null);
  }
  assert.equal(parseLiveGame(game({ allPlayers: [player({ championName: '金克丝' })] }), db).championId, 'Ahri');
});

test('rejects ambiguous champion catalog matches', () => {
  const ambiguous = { ...db, champions: [...db.champions, { id: 'OtherAhri', name: '阿狸', title: 'other' }] };
  assert.equal(parseLiveGame(game({ allPlayers: [player({ rawChampionName: '阿狸' })] }), ambiguous), null);
});

test('only ARAM and KIWI modes are eligible for live synchronization', () => {
  for (const gameMode of ['ARAM', 'KIWI']) assert.equal(parseLiveGame(game({ gameData: { gameMode } }), db).championId, 'Ahri');
  for (const gameMode of ['CLASSIC', 'TUTORIAL', 'CHERRY', 'PRACTICETOOL', '', null, undefined]) {
    assert.equal(parseLiveGame(game({ gameData: { gameMode, mapName: 'Map12' } }), db), null);
  }
  assert.equal(parseLiveGame(game({ gameData: undefined }), db), null);
});

test('owned equipment includes only catalog completed items, deduplicated to six slots', () => {
  const completed = db.items.slice(0, 7).map(item => item.id);
  const items = [
    { itemID: 1036 }, { itemID: 2003 }, { itemID: 3340 }, { itemID: 99999999 },
    ...completed.flatMap(id => [{ itemID: Number(id) }, { itemID: id }]),
  ];
  assert.deepEqual(parseLiveGame(game({ allPlayers: [player({ items })] }), db).owned, completed.slice(0, 6));
});

test('evolved Tear items remain owned and are not recommended for repurchase', () => {
  for (const [championId, evolved, base] of [['Ryze', 3040, '3003'], ['Ezreal', 3042, '3004'], ['Malphite', 3121, '3119']]) {
    for (const itemID of [evolved, String(evolved)]) {
      const live = parseLiveGame(game({ allPlayers: [player({ rawChampionName: `game_character_displayname_${championId}`, items: [{ itemID }] })] }), db);
      assert.deepEqual(live.owned, [base], `${championId}: evolved item must retain the completed purchase`);
      const builds = recommendBuilds({ ...emptySession(), ...live }, db);
      assert.ok(builds.length > 0);
      for (const build of builds) {
        assert.equal(build.items.filter(item => item.id === base).length, 1);
        assert.notEqual(build.next?.id, base, 'already-evolved item must not be a next purchase');
      }
    }
  }
});

test('base and evolved IDs occupy one owned slot and do not discard other purchases', () => {
  const items = [3040, 3003, '3042', '3004', 3121, 3119, 3089, 3135, 3020].map(itemID => ({ itemID }));
  assert.deepEqual(parseLiveGame(game({ allPlayers: [player({ items })] }), db).owned, ['3003', '3004', '3119', '3089', '3135', '3020']);
});

test('malformed item collections and entries do not throw or create equipment', () => {
  for (const items of [{ 0: { itemID: 3089 } }, '3089', true, null, undefined, [null, {}, 3089, { itemID: {} }, { itemID: '3089.0' }, { itemID: NaN }, { itemID: Infinity }, { itemID: -3089 }]]) {
    assert.deepEqual(parseLiveGame(game({ allPlayers: [player({ items })] }), db).owned, []);
  }
});

test('gold comes from the active player and is finite, integral and bounded', () => {
  for (const [currentGold, expected] of [[0, 0], [-30, 0], [123.99, 123], [1000000, 99999], [99999.99, 99999], [NaN, null], [Infinity, null], ['1000', null], [undefined, null]]) {
    const payload = game();
    payload.activePlayer.currentGold = currentGold;
    payload.allPlayers[0].currentGold = 7777;
    assert.equal(parseLiveGame(payload, db).gold, expected);
  }
});

test('game time keeps valid fractional seconds and rejects missing or negative values', () => {
  for (const [gameTime, expected] of [[0, 0], [12.5, 12.5], [-1, null], [Infinity, null], ['100', null], [undefined, null]]) {
    assert.equal(parseLiveGame(game({ gameData: { gameMode: 'KIWI', gameTime } }), db).gameTime, expected);
  }
});

test('missing active player or malformed payload never chooses the first player', () => {
  for (const payload of [undefined, null, {}, { allPlayers: [player()] }, game({ activePlayer: null }), game({ allPlayers: {} })]) {
    assert.equal(parseLiveGame(payload, db), null);
  }
});
