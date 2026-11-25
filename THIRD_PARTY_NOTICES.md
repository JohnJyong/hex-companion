# Third-party notices

The original Hex Companion code is distributed under the [MIT License](https://github.com/JohnJyong/hex-companion/blob/main/LICENSE).
The Windows distribution includes it as `LICENSE-HexCompanion.txt` alongside Electron's own license.
The terms below apply to the separately sourced data, artwork, software and OCR model.

## Community guide indexes — arammayhem.com, CC BY 4.0

`app/data/community-guides.json` adapts structural records from the public
[combos JSON export](https://arammayhem.com/data/v1/latest/combos.json), using the
[augment dictionary](https://arammayhem.com/data/v1/latest/augments.json) to resolve
names against this application's current KIWI catalog. The publisher's
[data and citation page](https://arammayhem.com/data/) and both JSON wrappers
license these exported facts under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

Required attribution: **[数据来源：arammayhem.com](https://arammayhem.com/data/)**
(Data: arammayhem.com). Preserve this attribution, the license link, source links
and modification notice when redistributing these adapted records. This permission
applies to the public data export; it is not a claim that all website prose or
images have the same license. No endorsement by the source or Riot Games is implied.

Reviewed source release: `website:20261117_104116:1cab57535c99`; checked **2026-11-18**.
The 665 exported records yield **420 indexes covering 147 heroes**: 245 records
containing an unmapped, renamed or retired augment were excluded in full. Chinese
source paths are present in the publisher's
[sitemap](https://arammayhem.com/sitemap-0.xml); the export's canonical English URL
and numeric combo ID are retained per entry. A source's legacy `slug` can differ
from its published URL and is not used to construct links.

Changes made: map exact names to local hero/augment IDs, remove duplicate or
unresolved relationships, preserve source tags, and generate short Chinese index
labels. No third-party guide body, damage claim, item build, win rate or rating is
copied. There are 29 cautionary and 21 entertainment indexes; these are not all
recommendations. A multi-augment record means `mentioned-together`, not a verified
requirement to obtain every listed augment. The export supplies no item relation
or individual guide patch/update date, so `itemIds` remains empty and `patch` is
null. `checkedAt` is the import review date, not a guide update or gameplay
validation date. These fixed indexes do not update themselves online.

Source integrity recorded at review:

| Export | SHA-256 |
| --- | --- |
| `combos.json` | `710355abf7b91df296a5518966bdfdeee5a51cd415b6626df5fe52ef118b2375` |
| `augments.json` | `739898ebc97e561738f2257d72f5082f9fa3be473fdc980f90dd4c818a32a3c0` |
| `index.json` | `a86689f84f4860e8ae809a08161295ca5e61ee32340e2a769d8d69f73a737eba` |

Rebuild explicitly with `python3 scripts/import-community-guides.py`; an unexpected
source release or license stops the import for review. `--offline` uses locally
cached source exports. An audit report with source hashes and rejected row IDs is
written under `.cache/references/arammayhem/import-report.json`.

This export's CC BY 4.0 license is separate from the CC BY-NC 4.0 AramHex statistics
below; it does not remove the application's existing non-commercial data restrictions.

## Local OCR — Tesseract.js and Tesseract.js-core, Apache-2.0

The application bundles [Tesseract.js 7.0.0](https://github.com/naptha/tesseract.js/tree/v7.0.0)
and [Tesseract.js-core 7.0.0](https://github.com/naptha/tesseract.js-core/tree/v7.0.0)
for local WebAssembly OCR. Both projects are distributed under Apache License 2.0.
Copies of the original license texts are retained in
[third_party/licenses/tesseract-js.txt](third_party/licenses/tesseract-js.txt) and
[third_party/licenses/tesseract-js-core.txt](third_party/licenses/tesseract-js-core.txt).
The dependencies also retain their upstream license files in the packaged modules.
The application adapter uses the public API; the upstream OCR sources are not modified.

## Bundled OCR model — tessdata_fast, Apache-2.0

`app/data/ocr/chi_sim.traineddata` is an unmodified Simplified Chinese model
from the official [tesseract-ocr/tessdata_fast repository](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd),
pinned to commit `87416418657359cb625c412a48b6e1d6d41c29bd`.
The [license at that revision](https://github.com/tesseract-ocr/tessdata_fast/blob/87416418657359cb625c412a48b6e1d6d41c29bd/LICENSE)
is Apache License 2.0 and is included as
[third_party/licenses/tessdata-fast.txt](third_party/licenses/tessdata-fast.txt).

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `chi_sim.traineddata` | 2,469,156 | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |

The exact download URL and hash are recorded in `app/data/ocr/manifest.json`.
The model ships with the application and is read locally; no first-run model download
or Windows OCR language component is required. These OCR licenses are separate from
the non-commercial statistics license below.

## Independently published data

Starting with 0.7.0 the [data-v1 channel](https://github.com/JohnJyong/hex-companion/tree/data-v1) distributes the catalog, PNG artwork, statistics, original recommendation rules and attributed guide indexes separately. The bundled snapshot described below remains available offline. Each online statistics table retains its license, source tag, file hashes, game patch, sample count and cutoff. The first 26.23 release adapts [data-v20](https://github.com/czgreat/aramhex-data/tree/data-v20/patches/16.23/normal), covering 4,991,976 valid matches through 2026-11-20 08:00 UTC+08:00. The same source restrictions and attribution obligations apply to downloaded copies.

## AramHex statistics — CC BY-NC 4.0

`app/data/champion-stats.json` contains the unchanged hero-statistics rows from
[czgreat/aramhex-data](https://github.com/czgreat/aramhex-data), dataset
[`data-v18 / patches/16.22/normal/heroes.json`](https://github.com/czgreat/aramhex-data/blob/data-v18/patches/16.22/normal/heroes.json).

Required attribution: **海克斯大乱斗统计数据（github.com/czgreat/aramhex-data），CC BY-NC 4.0**.

The statistics are licensed under
[Creative Commons Attribution-NonCommercial 4.0 International](https://github.com/czgreat/aramhex-data/blob/main/LICENSE).
They are included in this free, non-commercial community project. **The data cannot be
used commercially under this license.** A commercial release needs separately
licensed or independently sourced statistics; the application code's license does
not change the statistics license. Preserve the source, attribution, license link,
and this notice when redistributing the dataset. No endorsement by its author is implied.

Changes made here: the upstream hero rows are unchanged. The application adds
metadata describing the game mode, display patch, provenance, and use restrictions.
The raw source file's verified SHA-256 is
`5b6ecbfcb7cb2c821355f721df90de272631bb83360a76fcaa7de7640df419f4`.

Snapshot: 2026-11-15 17:00 (UTC+08:00), internal game patch 16.22 / displayed patch
26.22, **normal-rules ARAM: Mayhem (KIWI), all sampled skill bands**. This is not
classic ARAM data. The source includes 48,081,485 valid matches across seven China
regions. These are sampled observations, not all-server or real-time statistics.
The pick rate is a share of champion appearances, not a share of matches.

### Hero × augment and equipment statistics

`app/data/augment-stats.json` and `app/data/item-stats.json` also derive from the
same pinned `data-v18 / patches/16.22/normal` release, under the same **CC BY-NC 4.0,
non-commercial-only** terms and attribution above. `scripts/update-stats.py`
verifies every raw source file against the tagged SHA-256 manifest before creating
either file. Their metadata preserves the source file hashes, patch, sample window,
license, and upstream exclusions. The original statistical rows are unchanged;
the application wraps/renames tables and limits the augment dictionary to its
current KIWI catalog.

Included tables: `heroes.json`, `hero_augments.json`, `augments.json`,
`core_builds.json`, `hero_item_recommendations.json`, `hero_augment_items.json`,
`equipment_recommendation_heroes.json`, `item_metadata.json`, and `meta.json`.
Item names and images in the upstream metadata remain the original rights holders'
property; the statistics license does not relicense game assets.

Augment win rate is the observed rate for that hero ending a match with the augment.
Displayed delta is `(hero-augment win rate − hero baseline win rate) × 100`, in
**percentage points (pp)**. It is not a causal or relative percentage improvement.
Same-rarity ranks use the current catalog and at least 3,000 non-low-sample
appearances. S/A/B/C/D grades are this application's explicitly described percentile
buckets, not upstream or official ratings. Missing samples have no invented rate,
rank or grade.

Equipment `core_builds.json` describes the observed first **three legendary
items**, after the upstream participant/augment exclusions; its win rate never
describes this application's additional items or modified six-slot plan. The
separate augment-item table currently supplies Destiny Weapon references only,
using the first SUMMARY legendary-item record proxy. Other augment combinations
have no conditional equipment statistics here. Rule-based completions and changes
remain labelled as such.

## AramHex program — MIT

Architecture and recognition behavior were researched from
[czgreat/aramhex](https://github.com/czgreat/aramhex). Its program code uses the MIT
license, reproduced in [third_party/licenses/aramhex.txt](third_party/licenses/aramhex.txt).
The champion-select portrait/grid proportions were cross-checked against the user reference and [AramHex's champion-select layout](https://github.com/czgreat/aramhex/blob/main/lolhex/vision/champselect.py). Portrait matching, OCR sampling and the two badge surfaces are implemented locally.

The current statistics adapter was written for this application; the retained MIT
notice does **not** apply to the separately licensed AramHex statistics.

## ARAM-tool reference

[ MJ33520/ARAM-tool ](https://github.com/MJ33520/ARAM-tool) was reviewed for feature
ideas. Its README states MIT, but the inspected repository did not contain a
standalone LICENSE file. No source code or scraped ApexLol / OP.GG datasets from
that project are bundled here.

## Riot Games / Tencent assets

Hex Companion uses Riot Games assets under its [Legal Jibber Jabber policy](https://www.riotgames.com/en/legal).
Riot Games does not endorse or sponsor the project. The views expressed are those of
its contributors. League of Legends and related marks belong to Riot Games, Inc.
Champion, item, and augment artwork and descriptions remain the property of their
respective rights holders. Catalog sources are recorded in `app/data/catalog.json`.
