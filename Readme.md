# mc-client-worker

一个专为低配容器与受限磁盘环境设计的轻量级 Minecraft 挂机机器人（基于 Mineflayer）。项目采用「零预装依赖 + 运行时流式瘦身引导」架构，默认以原地拟人挂机模式运行，内置防检测动作、可选地形安全漫步与智能断线重连机制。核心特性1. 极简运行环境与依赖瘦身（Bootstrap v5）零预装依赖：package.json 无需声明重型依赖，首次启动由 index.js 自动完成运行时构建，重启后通过 runtime/.ready 缓存标记秒级跳过。流式裁剪 minecraft-data：通过原生的 TCP Ping 自动探测目标服务器版本，流式下载并仅解压所需版本的数据（默认保留 1.21.4、1.21.6、1.21.10、1.21.11、26.3、最新正式版及目标探测版本），彻底跳过 Bedrock 数据、测试及文档文件，大幅压缩磁盘占用。绕过受限 /tmp 分区：将 npm 缓存与临时目录完全重定向至项目 runtime/ 目录下，安装结束后自动清理缓存并修剪 node_modules 中的 .map、.d.ts、.md 等冗余文件，适配仅 32MB /tmp 的免费面板容器。2. 拟人化防检测行为默认原地拟人挂机：默认关闭随机走动（movement.enabled: false），避免偏离挂机点位或误入危险区域；机器人会按非均匀随机间隔（包含短时连贯操作与长时发呆停顿）执行环顾四周、注视 8 格内的玩家/生物、短暂潜行、切换快捷栏与挥手动作。平滑视角转动：采用缓动曲线（Ease-In-Out）分段转头并加入微小随机抖动，模拟真实鼠标操作。可选安全范围漫步：若手动开启 behavior.movement.enabled，机器人将以进服/重生位置为锚点，在限定半径内随机走动、偶发疾跑/侧移/跳跃；移动前自动检测前方及脚下两格方块，避开岩浆、火焰、仙人掌、岩浆块、甜浆果丛、营火、水源与深坑。生存辅助：饥饿值低于 16 时自动从背包寻找并食用食物；落水时自动触发上浮跳跃防止溺水。3. 会话轮换与高可用重连定时下线休息：支持配置随机在线时长，到达后主动退出服务器并在短时间内重新上线，模拟真实玩家作息。智能重连策略：内置 90 秒登录看门狗、指数退避重连（附带随机抖动），并能自动识别连接限流提示（如 throttled / wait / too fast）延长等待时间至 60–100 秒。环境要求Node.js：>= 18.0.0（依赖原生 fetch、Readable.fromWeb 与 AbortSignal.timeout）网络：首次启动需访问 registry.npmjs.org 及 cdn.jsdelivr.net / unpkg.com 拉取依赖快速开始克隆或上传项目文件（index.js、package.json、settings.json）至运行目录。编辑 settings.json，填入目标服务器地址与机器人账号信息。启动程序：npm start
# 或直接运行
node index.js
首次启动会自动创建 runtime/ 目录并执行瘦身安装，耗时视网络情况而定；后续启动将直接复用已构建的运行时环境。配置说明（settings.json）{
  "bot-account": {
    "username": "PlayerName",
    "password": "",
    "type": "offline"
  },
  "server": {
    "ip": "play.example.com",
    "port": 25565,
    "version": ""
  },
  "behavior": {
    "session": {
      "enabled": true,
      "minOnlineMin": 25,
      "maxOnlineMin": 55,
      "minOfflineSec": 35,
      "maxOfflineSec": 105
    },
    "movement": {
      "enabled": false,
      "maxRadius": 6
    },
    "actionIntervalSec": {
      "min": 7,
      "max": 32
    },
    "autoEat": true
  },
  "utils": {
    "auto-auth": {
      "enabled": false,
      "password": "YourPassword123"
    },
    "auto-reconnect-delay": 5000,
    "max-reconnect-delay": 60000
  }
}
字段详解配置项类型默认值说明bot-account.usernamestring-机器人游戏名（离线服）或账号邮箱bot-account.passwordstring""账号密码（离线模式留空即可）bot-account.typestring"offline"登录验证方式，支持 offline 或 microsoftserver.ipstring-目标 Minecraft 服务器域名或 IPserver.portnumber25565服务器端口server.versionstring""指定协议版本（如 "1.21.4"）；留空则自动探测服务器版本behavior.session.enabledbooleantrue是否开启定时主动下线休息机制behavior.session.minOnlineMin / maxOnlineMinnumber25 / 55单次连续在线时长范围（分钟，最小 5 分钟）behavior.session.minOfflineSec / maxOfflineSecnumber35 / 105计划下线后的休息重连间隔（秒，范围限制在 10–110 秒）behavior.movement.enabledbooleanfalse是否启用随机走动；默认关闭（仅原地挂机），设为 true 开启安全范围漫步behavior.movement.maxRadiusnumber6开启走动后，相对出生/重生锚点的最大活动半径（格）behavior.actionIntervalSec.min / maxnumber7 / 32随机动作的基础触发间隔范围（秒）behavior.autoEatbooleantrue饥饿值低于 16 时是否自动进食utils.auto-auth.enabledbooleanfalse进服后是否自动发送 /login <password>utils.auto-auth.passwordstring-进服自动登录插件密码utils.auto-reconnect-delaynumber5000异常断线后的初始重连延迟（毫秒）utils.max-reconnect-delaynumber60000指数退避重连的最大延迟上限（毫秒）目录结构.
├── index.js          # 依赖瘦身引导脚本与挂机机器人核心逻辑
├── package.json      # 项目入口与启动脚本定义
├── settings.json     # 服务器、账号与行为配置文件
└── runtime/          # 首次启动自动生成的运行时目录（包含瘦身后的依赖与 .ready 标记）
常见问题切换了目标服务器版本后无法进服怎么办？
若新服务器版本不在默认保留列表中，删除 runtime/ 目录（或删除 runtime/.ready）后重启，引导脚本会自动重新探测并拉取对应版本协议数据。如何自定义默认保留的 Minecraft 版本？
修改 index.js 顶部的 KEEP_MC_VERSIONS 数组后，删除 runtime/.ready 重启即可生效。
