import bundled from '../data/recommendation-rules.json' with {type:'json'};

// One rulebook per renderer. A data change reloads the workbench between games.
export let advice, augmentRules, aliases;
export const pairKey = (a, b) => a < b ? a + '|' + b : b + '|' + a;

export function useRecommendationRules(data = bundled) {
  augmentRules = Object.assign(Object.create(null), data.augments);
  aliases = data.champions.aliases;
  const groupIndex = new Map();
  for (const [type, ids] of Object.entries(data.champions.groups)) {
    for (const id of ids.split(' ')) groupIndex.set(id, type);
  }
  advice = {
    ...data,
    champions:{...data.champions, groupIndex, noDashes:new Set(data.champions.noDashes)},
    directPairs:new Map(data.directPairs.map(([a,b,reason])=>[pairKey(a,b),reason])),
  };
}

useRecommendationRules();
