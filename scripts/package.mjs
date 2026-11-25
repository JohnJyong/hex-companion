import { packager } from '@electron/packager';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, cp, readFile, writeFile } from 'node:fs/promises';
import { buildDataPackage } from './pack-data.mjs';

const [platform = 'win32', arch = 'x64'] = process.argv.slice(2);
if (platform !== 'win32' || arch !== 'x64') throw new Error('Only Windows x64 is supported');
const apps = await packager({
  dir: resolve('.'), out: resolve('release'), name: 'HexCompanion',
  executableName: 'HexCompanion', appBundleId: 'app.hexcompanion.desktop',
  appCopyright: 'Independent community companion. League of Legends assets © Riot Games.',
  platform, arch, overwrite: true, asar: { unpack: '**/{*.ps1,ocr-worker.cjs}', unpackDir: '{node_modules,app/data/ocr}' },
  icon: resolve('app/assets/app-icon.ico'),
  ...(existsSync(resolve(`.cache/electron/electron-v45.3.3-${platform}-${arch}.zip`)) ? { electronZipDir: resolve('.cache/electron') } : {}),
  ignore: [/^\/release($|\/)/, /^\/data($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/design-qa\.md$/, /^\/artifacts($|\/)/, /^\/\.git(hub)?($|\/)/, /^\/\.cache($|\/)/],
  prune: true,
  afterCopy: [async ({buildPath}) => {
    const appRoot = join(buildPath,'app');
    const file = join(appRoot,'data/bundled-snapshot.json');
    const {revision} = JSON.parse(await readFile(file,'utf8'));
    const {manifest} = await buildDataPackage(appRoot,revision);
    await writeFile(file,JSON.stringify(manifest,null,2)+'\n');
  }],
});
const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
for (const directory of apps) {
  // Keep Electron's license alongside the application's own license.
  await copyFile(resolve('LICENSE'), join(directory, 'LICENSE-HexCompanion.txt'));
  await copyFile(resolve('README.md'), join(directory, 'README.md'));
  await copyFile(resolve('THIRD_PARTY_NOTICES.md'), join(directory, 'THIRD_PARTY_NOTICES.md'));
  await cp(resolve('third_party'), join(directory, 'third_party'), { recursive: true });
  await cp(resolve('docs'), join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, '使用说明.txt'), '\uFEFF' + [
    `海克斯参谋 ${version} · Windows 10 / 11 x64 测试版`,
    '',
    '1. 解压整个文件夹，运行 HexCompanion.exe。不要单独移动 exe。',
    '2. 在选人前打开助手。国服客户端处于前台并出现「可用」英雄栏后，左侧队伍和顶部备选席会显示常规海克斯英雄胜率。在「实时识别」可关闭选人提示。',
    '3. 进入实际对局后，在「实时识别」刷新窗口并启动对局内识别，切回游戏。建议使用无边框或窗口模式。',
    '4. 英雄、成装与金币从本机游戏接口读取；海克斯候选由本地 OCR 自动识别，三个穿透标签贴在候选卡片上方。',
    '5. 三选一面板仍显示且识别稳定时，Ctrl+Alt+1/2/3 记录要选的左/中/右项，再到游戏中确认。下一轮会显示与已记录海克斯的联动理由。',
    '6. 游戏在前台时按 Ctrl+Alt+H 或 F8 显示或隐藏标签，也可用主窗口的隐藏按钮；隐藏后识别更新不会重新显示。',
    '7. 在「攻略库」按英雄、海克斯或装备搜索。候选详情和出装预览会显示相关攻略，可以打开原文。',
    '8. 局内右上角显示下一件成装、整件价格与后续购买顺序，卡片关闭后仍可查看。主窗口侧栏「推荐出装」可查看六格路线。「停止识别」只结束对局内识别，退出助手会同时关闭选人提示。',
    '',
    '无需账号、API Key、Node.js 或系统 OCR 语言包。截图不上传、不保存。',
    '短暂漏读最多显示 1.5 秒灰色待复核结果，期间不能用快捷键记录；候选消失后可在「已选海克斯」手动补录。',
    '快捷键只记录助手状态，不会点击卡片、购买装备或向游戏发送按键。切出游戏时暂停画面识别并隐藏标签。',
    '当前为测试版：已通过逻辑、界面、离线 OCR 图片与包内资源检查；Windows 游戏实机截图、识别准确率和叠层兼容性仍待验收。',
    '英雄、海克斯、装备、攻略和图标可独立更新。在「设置与数据」检查更新；默认每 6 小时检查，下载后下次启动自动生效，停止识别后也可立即应用。断网时使用本机快照。',
    'pp 表示该英雄持有海克斯胜率与英雄基准胜率之差，不是因果提升。S 等级由本工具按同阶排名分位计算，缺数据时不编造胜率。',
    '装备样本只覆盖标明的前三件核心，海克斯调整及其余装备属于规则参考；不代表六件套胜率，也不保证收益最大化。',
    '统计数据采用 CC BY-NC 4.0，仅限非商业使用；详情见 THIRD_PARTY_NOTICES.md。',
    '',
    '完整使用与开发说明：README.md',
  ].join('\r\n'), 'utf8');
}
console.log(apps.join('\n'));
