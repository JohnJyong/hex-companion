# 海克斯参谋数据源

Windows 助手从这个分支读取游戏资料。当前数据编号、游戏版本、统计截止时间和两个压缩文件的 SHA-256 可在[发布清单](manifest.json)查看。使用方法见[桌面助手 README](https://github.com/JohnJyong/hex-companion/blob/main/README.md)。

`tables-*.json.gz` 包含 KIWI 模式的目录、常规模式全体样本的英雄胜率、英雄与海克斯和装备的组合统计，以及攻略索引。统计表的 `meta.source` 记录原始发布标签、上游文件哈希和许可。攻略条目保留了原始资料链接、适用版本及核对日期。初次独立发布的数据来自 [AramHex data-v20](https://github.com/czgreat/aramhex-data/tree/data-v20/patches/16.23/normal)。

`icons-*.json.gz` 按目录路径存储英雄、海克斯和装备的 PNG 图标。客户端只下载内容发生变化的压缩包。更新由[主仓库的发布流程](https://github.com/JohnJyong/hex-companion/actions/workflows/data-channel.yml)维护。

## 来源与使用许可

- **海克斯大乱斗统计数据（github.com/czgreat/aramhex-data），CC BY-NC 4.0**。仅限非商业使用。保留英雄行，筛选 KIWI 候选，组合相关统计表并附加版本及使用口径。[上游数据与许可](https://github.com/czgreat/aramhex-data/blob/main/LICENSE)
- **数据来源：arammayhem.com**。社区搭配索引按英雄和海克斯 ID 做了映射与筛选，条目保留署名及来源链接。[来源](https://arammayhem.com/data/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- 英雄、技能、物品和游戏图像通过 Riot Data Dragon 和 CommunityDragon 获取，相关游戏素材权利归原权利人。海克斯参谋为独立社区工具。[Riot 素材使用政策](https://www.riotgames.com/en/legal) · [完整第三方声明](https://github.com/JohnJyong/hex-companion/blob/main/THIRD_PARTY_NOTICES.md)
