# 海克斯助手参考项目评审

核对日期：2026-11-17。目标是仅面向 Windows 的实时桌面助手：自动获得当前候选，解释英雄适配与组合关系，给出装备路径。以下区分参考项目实现、本项目已接入内容和后续工作；没有运行两个参考项目的第三方程序。

## 两个项目的取舍

| 方面 | czgreat/aramhex | MJ33520/ARAM-tool | 本项目 0.3 的选择 |
| --- | --- | --- | --- |
| 技术栈 | Python、PySide6、RapidOCR／ONNX、OpenCV | Python 桌面界面、Gemini、LCU／Live Client | Electron、随包 Tesseract.js OCR、本机 Live Client |
| 识别 | 窗口截屏，本地 OCR；定位后小区域追踪 | 截图调用 Gemini；当前代码也读客户端接口 | 用户选定窗口后，本地识别三列标题，无需 API Key |
| 持续更新 | 指纹、逐列确认，处理重随与消失 | 云端识别与推荐分两次调用，受网络和模型响应影响 | 标题条追踪、确认后指纹复用；短暂漏读灰色复核 |
| 数据 | 自采公开统计、腾讯公开资料与部分官方建议 | ApexLol、OP.GG 抓取及缓存 | 客户端目录＋定版英雄、海克斯和装备统计 |
| 展示 | 英雄／海克斯胜率、出装、加点等 | 阵容、打法、海克斯和装备文字分析 | 三卡贴图标签、真实样本、机制解释、核心装备 |
| 程序许可 | MIT，有完整 LICENSE | README 写 MIT，核对时无独立 LICENSE 文件 | 采用架构思路，适配器自行实现 |
| 数据许可 | aramhex-data 为 CC BY-NC 4.0 | 外部数据版权归各提供方 | 保留归属，仅供个人非商业原型 |

## aramhex 中值得采用的设计

来源：[仓库 README](https://github.com/czgreat/aramhex)、[OCR 实现](https://github.com/czgreat/aramhex/blob/main/lolhex/vision/ocr.py)、[候选识别器](https://github.com/czgreat/aramhex/blob/main/lolhex/vision/detector.py)。

- **只识别必要区域。** aramhex 首次在窗口中部寻找标题，定位后只读窄条和三列小块，降低无关文字与处理负载。RapidOCR 设置了 ONNX 线程限制。本项目使用随包 Tesseract.js：首次完整客户区定位，再按实际标题坐标追踪窄条；确认后才使用指纹复用，并定期重读。
- **按新观察确认变化。** 重随可能改变一列或整组；不能把同一缓存帧重复计作确认。本项目有连续帧、重复帧、同阶级、三列布局和近似名称约束。明确的新候选撤下旧分数；短暂漏读则最多保留 1.5 秒灰色“待复核”结果，期间禁止记录。
- **处理窗口与自身界面。** [capture.py](https://github.com/czgreat/aramhex/blob/main/lolhex/vision/capture.py) 遮蔽自身浮窗、检测空白截图，分辨率变化使校准失效。当前本项目要求游戏前台可见，浮窗应避开标题；实际叠层仍需 Windows 验证。
- **让数据口径随建议展示。** [public.py](https://github.com/czgreat/aramhex/blob/main/lolhex/data/public.py) 保留版本、样本、分段与来源，核对下载清单哈希。本项目英雄、海克斯与装备统计均保留版本、截至时间、样本数和许可。

这些设计说明实时识别需要状态管理，不能只做一次字符串匹配。参考源码注释中的耗时不是本项目性能承诺。

## ARAM-tool 的功能价值与局限

来源：[README](https://github.com/MJ33520/ARAM-tool)、[main.py](https://github.com/MJ33520/ARAM-tool/blob/master/main.py)、[lcu_client.py](https://github.com/MJ33520/ARAM-tool/blob/master/lcu_client.py)、[gemini_analyzer.py](https://github.com/MJ33520/ARAM-tool/blob/master/gemini_analyzer.py)。

阵容上下文、已有海克斯历史、可折叠浮窗和缓存资料值得借鉴。后续可利用敌我阵容扩展出装，而不只依赖用户手动标记的伤害、回复、控制及前排情况。

当前源码已经读取 LCU 与 Live Client，README 中“仅通过截图”的说明未反映这些实现。本项目目前只读固定本机 Live Client 地址，不含该项目的进程参数查找或 LCU 登录流程。

海克斯分析先请求 Gemini 识别截图，再请求模型生成建议，需要密钥与网络；不适合作为本项目实时选择的必需依赖。本项目使用本地 OCR 与规则引擎。

其 `get_player_augment_count()` 根据符文 ID 大小猜海克斯数量，属于代码中的经验假设，不宜据此判断实际选卡。本项目在面板仍显示、当前候选稳定时，用热键记录准备选择的选项，再由玩家在游戏确认；面板消失或识别不清时禁用记录热键。已经点选的结果可手动补录，不根据面板消失猜结果。

[opgg_scraper.py](https://github.com/MJ33520/ARAM-tool/blob/master/opgg_scraper.py) 将 `performance` 描述为胜率表现，本次没有独立核对源站字段定义和样本量，不能作为已验证胜率。ApexLol／OP.GG 的页面结构、模式、授权与缓存时效需另外处理；本项目没有打包这些抓取数据。

## 已接入的统计与口径

采用 [czgreat/aramhex-data](https://github.com/czgreat/aramhex-data) 的固定发布 [data-v18](https://github.com/czgreat/aramhex-data/tree/data-v18/patches/16.22/normal)。上游 [读取说明](https://github.com/czgreat/aramhex-data/blob/main/AGENTS.md) 和 [统计口径](https://github.com/czgreat/aramhex-data#统计口径)提供字段与限制。

| 项目 | 本次快照 |
| --- | --- |
| 路径 | `patches/16.22/normal/` 下英雄、海克斯与装备统计表 |
| 玩法 | 国服常规海克斯大乱斗，映射为 `KIWI / normal` |
| 分段 | 全体样本；没有将自定义分段标成官方排位段位 |
| 版本 | 内部 16.22，本项目公开展示 26.22 |
| 时间窗 | 2026-11-05 04:08:36 至 2026-11-15 17:00，北京时间 |
| 有效对局 | 48,081,485 |
| 覆盖 | 七个大区，173 位英雄 |
| 核验 | SHA-256 与清单一致；总出场为有效局数 × 10，总胜场为有效局数 × 5 |
| 许可 | CC BY-NC 4.0，保留归属，限非商业用途 |

原始英雄表按官方数字 ID 存储 `games / wins / win_rate / pick_rate / rank`。本项目通过目录 `gameId` 对应，不用中文名猜测。原始统计行未修改，只新增模式、日期、来源和许可元数据。

统计覆盖已采集对局，合并七区与版本热修前后记录，不是全服实时胜率。`pick_rate` 的分母是全部英雄出场次数。观察胜率不能证明选择某个英雄或海克斯的因果收益。

0.3 另外接入 `hero_augments.json`、`core_builds.json`、`hero_item_recommendations.json` 与 `hero_augment_items.json` 等表，由 [update-stats.py](../scripts/update-stats.py) 按固定清单校验后打包。当前目录有 241 个海克斯，上游统计字典覆盖其中 225 个；每个英雄实际有记录的集合还会更小，无记录时不补造胜率。

海克斯差值为 `(该英雄持有此海克斯的胜率 − 同英雄全体基准胜率) × 100`，单位 pp。同阶排名只使用该英雄、当前 KIWI 目录、至少 3,000 次出场且非低样本的记录。S／A／B／C／D 是本工具的排名分位标签（前 10%／30%／60%／85%／其余），不是上游或官方评级。排序使用经过样本平滑的内部信号与现有机制修正，展示的胜率与 pp 仍是原始统计；已确认的严重机制冲突优先排除。

装备证据只覆盖原始前三件传说装备顺序。上游排除了装备升级、合成、赠装等干扰海克斯的人次，因此选择这些海克斯后，不能直接套用该核心的统计胜率。命运之武器另有同英雄首条传说装备记录的参考，其余海克斯没有条件装备统计。后续补齐的鞋子、六格装备与机制调整均标为规则参考，不能以原始三件套胜率包装整套或修改后的路线。

全部仍是固定版本快照，不自动联网更新，也不包含已经验证的多海克斯组合胜率或最优伤害模型。

所需归属：**海克斯大乱斗统计数据（github.com/czgreat/aramhex-data），CC BY-NC 4.0**。详见 [第三方声明](../THIRD_PARTY_NOTICES.md)。MIT 仅适用于 aramhex 程序代码，不改变数据的非商业限制。

## 本地 OCR 的部署依据

Tesseract.js 与 Tesseract.js-core 固定为 7.0.0；使用官方 `tessdata_fast` 固定提交的简体中文 `chi_sim` 模型。版本、文件哈希及授权见 [模型清单](../app/data/ocr/manifest.json) 和 [第三方声明](../THIRD_PARTY_NOTICES.md)。模型只支持 LSTM，因此使用 `OEM.LSTM_ONLY`。

Electron 主进程采用 Node 工作线程路径。依据 [v7 Node worker 默认路径](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker/node/defaultOptions.js)，`workerPath` 应指向 `src/worker-script/node/index.js`，不是浏览器版 `dist/worker.min.js`。[Node getCore](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/node/getCore.js) 直接从 `tesseract.js-core` 解析核心，不使用传入的 `corePath`；v7 会按设备选用普通、SIMD、relaxed SIMD 及各自 LSTM 核心。打包保留相应依赖与核心文件，工作线程、WASM、模型及 Windows 截图脚本使用真实解包路径，随 `app.asar.unpacked` 一同分发。[Electron ASAR 文档](https://github.com/electron/electron/blob/main/docs/tutorial/asar-archives.md)说明了归档路径与解包文件的区别。

[v7 语言加载实现](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/index.js) 支持 Node 本地路径。应用显式配置本机 `langPath`，原始模型使用 `gzip:false`，`cacheMethod:'none'`，不写默认工作目录缓存；缺少模型时报告错误，不回退至在线下载。

[v7 API 类型](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/index.d.ts) 的几何结果在 `data.blocks[].paragraphs[].lines[]`，不是顶层 `data.lines`。识别调用须开启 `{blocks:true}`；行和词的 `bbox` 由 `x0/y0/x1/y1` 转成 `x/y/width/height`，保留词坐标供三列拆分。只返回文字内容无法验证卡片布局。

## 当前验证范围与后续顺序

Windows 本地截屏与 OCR 分离：截屏程序返回内存中的 PNG，随包 Tesseract.js WebAssembly 引擎及简体中文 `chi_sim` 模型在本机完成识别；无需系统 OCR 语言包、API Key 或首次联网下载。0.3 将标题识别、Live Client 数据和原生按键检测分为独立循环，避免对局接口超时拖住画面与隐藏操作。识别约按 250 毫秒节奏调度，按键约每 50 毫秒检测；处理慢时不会并发堆积 OCR。

用户反馈环境为 **2560×1440、100% 缩放、无边框**。标题 ROI 来自完整客户区中的真实文字坐标，不假定固定的 y 位置；三张标签按物理屏幕坐标转换为 DIP，分别放在对应标题上方。游戏在前台时，`Ctrl+Alt+H` 或 `F8` 按下沿切换，主窗口另有隐藏按钮；隐藏状态不会被后续帧覆盖。短暂漏读使用最多 1.5 秒的灰色复核状态，新候选不继承旧分数。

在当前开发机，用用户提供的约 2.2K 宽游戏图片测试，完整画面 OCR 为约 **611–709 毫秒**，标题条为约 **47–72 毫秒**。这只比较同一机器、同一图片的 OCR 工作量，不包含 Windows GDI 截图、IPC、连续帧确认和标签渲染，不能作为 Windows 端到端延迟或普遍准确率承诺。

新增确定性回归通过注入时钟、未完成的请求和模拟窗口，覆盖游戏请求挂起时 OCR／隐藏键仍可推进、前台丢失后丢弃迟到 OCR、停止重启后丢弃旧事件、仅确认状态复用无图片心跳、1440p 的 100%／150% 缩放定位、隐藏后更新不重显、重复更新不反复显示窗口。测试还发现并促成修复“窗口枚举取消后仍初始化 OCR”的启动竞态。原生按键的测试边界是 helper 返回的按下沿协议，真实 Windows 按键路径仍需实机复测。

开发主机是 macOS；JavaScript、协议、OCR 组件和 Electron 界面检查不代表 Windows 截图链路、游戏识别效果或真实游戏叠层已通过实机验收。

## 0.3 装备问题修复依据

本次核对没有发现明确的 Arena-only 装备混入：目录 114 件均来自 Data Dragon 的地图 12 可购买项，地图 30 标记为 false。地图 12 标记只说明嚎哭深渊范围，仍不能单独证明所有物品在当前 KIWI 商店开放，不能仅凭高 ID 删除海克斯模式特有物品。

亚索三相问题来自通用战士画像和模板类型加分压过其暴击机制。已把亚索、永恩与蛮王的默认路线改为暴击优先，避免普通情况下套用三相模板，并接入英雄真实核心装备。回归覆盖亚索默认路线、“升级：无尽之刃”优先购买以及神射法师不强转纳什／帽子／法穿。选择装备改造海克斯后，上游排除口径不适用时会退回明确标注的机制路线。

同时修复通用攻击特效画像的 AP 偏高导致薇恩法强出装、蒙多套用战士路线、提莫 AD 路线优先、近战禁飓风后机械换火炮、战士重伤替换及新增咒刃／顺劈装备约束。Live Client 将升级后的炽天使、魔切、末日寒冬映射回对应已有成装，避免升级后被遗忘而重复推荐。装备合法性验证不能证明收益最优，统计与规则边界仍需在界面保留。

优先验证 1080p／1440p／4K、系统缩放、多屏、遮挡、前后台切换、重随动画、近似标题及模型文件缺失，记录实际耗时与误识别率后再调节扫描参数。随后补齐指定技能、任务和装备触发链，再扩展团队阵容和口径明确的统计数据。

热键只记录助手状态；自动点击、购买或模拟游戏按键不属于本次实现。输出为参考建议，不承诺提高胜率或保证最大收益。
