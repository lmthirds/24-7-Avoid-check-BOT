"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const zlib = require("zlib");
const { Readable } = require("stream");
const { spawnSync } = require("child_process");

const config = require("./settings.json");

const RUNTIME_DIR = path.join(__dirname, "runtime");
const SLIM_MC_DATA_DIR = path.join(RUNTIME_DIR, "slim-mc-data");
const READY_FLAG = path.join(RUNTIME_DIR, ".ready");
const KEEP_MC_VERSIONS = ["1.21.4", "1.21.6", "1.21.10", "1.21.11", "26.3"];
const RUNTIME_SIGNATURE = `v5:${KEEP_MC_VERSIONS.join(",")},latest`;

// ==================== 第一部分：轻量级自适应依赖引导（v5） ====================

function logDiskSpace() {
  if (typeof fs.statfsSync !== "function") return;
  for (const dir of [__dirname, "/tmp"]) {
    try {
      const st = fs.statfsSync(dir);
      const freeMB = ((Number(st.bavail) * Number(st.bsize)) / 1048576).toFixed(1);
      console.log(`[Init] 磁盘剩余空间 ${dir}: ${freeMB} MB`);
    } catch (_) {}
  }
}

function writeVarInt(val) {
  const bytes = [];
  let v = val >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let num = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: num, next: pos };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function pingServerVersion(host, port) {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    const socket = net.createConnection({ host, port: Number(port) || 25565 });
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (ver) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ver);
    };

    const timer = setTimeout(() => finish(null), 4000);

    socket.on("connect", () => {
      const hostBuf = Buffer.from(host, "utf8");
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(Number(port) || 25565, 0);

      const hsBody = Buffer.concat([
        writeVarInt(0),
        writeVarInt(767),
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(1),
      ]);
      const hsPacket = Buffer.concat([writeVarInt(hsBody.length), hsBody]);
      const statusReq = Buffer.from([0x01, 0x00]);
      socket.write(Buffer.concat([hsPacket, statusReq]));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const pktLen = readVarInt(buf, 0);
      if (!pktLen || buf.length < pktLen.next + pktLen.value) return;
      const pktId = readVarInt(buf, pktLen.next);
      if (!pktId || pktId.value !== 0) return finish(null);
      const strLen = readVarInt(buf, pktId.next);
      if (!strLen || buf.length < strLen.next + strLen.value) return;
      try {
        const json = JSON.parse(buf.subarray(strLen.next, strLen.next + strLen.value).toString("utf8"));
        const name = json && json.version && json.version.name ? String(json.version.name) : "";
        const m = name.match(/\d+\.\d+(?:\.\d+)?/);
        finish(m ? m[0] : null);
      } catch (_) {
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function buildAllowedPcDirs(mcDataVersion, targetVersion) {
  const urls = [
    `https://cdn.jsdelivr.net/npm/minecraft-data@${mcDataVersion}/minecraft-data/data/dataPaths.json`,
    `https://unpkg.com/minecraft-data@${mcDataVersion}/minecraft-data/data/dataPaths.json`,
  ];

  let dataPaths = null;
  for (const url of urls) {
    try {
      dataPaths = await fetchJson(url);
      if (dataPaths && dataPaths.pc) break;
    } catch (_) {}
  }
  if (!dataPaths || !dataPaths.pc) return null;

  const pcKeys = Object.keys(dataPaths.pc);
  const keepVersions = new Set();

  // 1. 保留指定版本列表：1.21.4、1.21.6、1.21.10、1.21.11、26.3
  for (const v of KEEP_MC_VERSIONS) {
    if (dataPaths.pc[v]) keepVersions.add(v);
  }

  // 2. 保留最新正式版
  const releaseKeys = pcKeys.filter((k) => /^\d+\.\d+(?:\.\d+)?$/.test(k));
  if (releaseKeys.length) {
    keepVersions.add(releaseKeys[releaseKeys.length - 1]);
  } else if (pcKeys.length) {
    keepVersions.add(pcKeys[pcKeys.length - 1]);
  }

  // 3. 若配置或探测到其他精确版本，一并保留兜底
  if (targetVersion && dataPaths.pc[targetVersion]) {
    keepVersions.add(targetVersion);
  }

  const allowedDirs = new Set();
  for (const ver of keepVersions) {
    const map = dataPaths.pc[ver];
    if (!map || typeof map !== "object") continue;
    for (const dirPath of Object.values(map)) {
      if (typeof dirPath === "string") allowedDirs.add(dirPath);
    }
  }

  console.log(
    `[Init] 精简协议映射完成，保留版本 [${Array.from(keepVersions).join(", ")}]（共 ${allowedDirs.size} 个数据目录，跳过全部 Bedrock）`
  );
  return allowedDirs;
}

async function downloadAndExtractSlimMcData(tarballUrl, destDir, allowedPcDirs) {
  const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(120000) });
  if (!res.ok || !res.body) throw new Error(`下载 minecraft-data 失败: HTTP ${res.status}`);

  fs.mkdirSync(destDir, { recursive: true });

  const shouldKeep = (relPath) => {
    if (!relPath || relPath.includes("..")) return false;
    if (
      relPath.startsWith(".github/") ||
      relPath.startsWith("test/") ||
      relPath.startsWith("doc/") ||
      relPath.endsWith(".map")
    ) {
      return false;
    }
    if (relPath.startsWith("minecraft-data/data/bedrock/")) {
      return relPath.startsWith("minecraft-data/data/bedrock/common/");
    }
    if (allowedPcDirs && relPath.startsWith("minecraft-data/data/pc/")) {
      const sub = relPath.slice("minecraft-data/data/pc/".length).split("/")[0];
      return sub === "common" || allowedPcDirs.has(`pc/${sub}`);
    }
    return true;
  };

  return new Promise((resolve, reject) => {
    let state = "HEADER";
    let buf = Buffer.alloc(0);
    let remaining = 0;
    let skipAfter = 0;
    let fd = null;
    let metaType = "";
    let metaChunks = [];
    let paxPath = null;
    let paxSize = null;
    let gnuLongPath = null;
    let kept = 0;
    let skipped = 0;

    const closeFd = () => {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {}
        fd = null;
      }
    };

    const parsePax = (b) => {
      let pos = 0;
      while (pos < b.length) {
        const sp = b.indexOf(0x20, pos);
        if (sp === -1) break;
        const len = parseInt(b.subarray(pos, sp).toString("ascii"), 10);
        if (!len || pos + len > b.length) break;
        const rec = b.subarray(sp + 1, pos + len - 1).toString("utf8");
        const eq = rec.indexOf("=");
        if (eq !== -1) {
          const k = rec.slice(0, eq);
          const v = rec.slice(eq + 1);
          if (k === "path") paxPath = v;
          else if (k === "size") paxSize = parseInt(v, 10);
        }
        pos += len;
      }
    };

    const processBuf = () => {
      while (true) {
        if (state === "HEADER") {
          if (buf.length < 512) break;
          const hdr = buf.subarray(0, 512);
          buf = buf.length > 512 ? buf.subarray(512) : Buffer.alloc(0);

          if (hdr.every((b) => b === 0)) continue;

          const name = hdr.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
          const prefix = hdr.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
          const typeflag = String.fromCharCode(hdr[156]);
          const sizeOct = hdr.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
          const fileSize = paxSize !== null ? paxSize : parseInt(sizeOct, 8) || 0;
          const padded = Math.ceil(fileSize / 512) * 512;

          if (typeflag === "x" || typeflag === "L") {
            metaType = typeflag;
            metaChunks = [];
            remaining = fileSize;
            skipAfter = padded - fileSize;
            state = remaining > 0 ? "META" : skipAfter > 0 ? "SKIP" : "HEADER";
          } else {
            const rawName = prefix ? `${prefix}/${name}` : name;
            const fullPath = paxPath || gnuLongPath || rawName;
            paxPath = null;
            paxSize = null;
            gnuLongPath = null;

            if (typeflag === "0" || typeflag === "\0") {
              const rel = fullPath.replace(/^\.?\//, "").replace(/^package\//, "");
              if (shouldKeep(rel)) {
                const outPath = path.join(destDir, rel);
                fs.mkdirSync(path.dirname(outPath), { recursive: true });
                fd = fs.openSync(outPath, "w");
                kept++;
              } else {
                fd = null;
                skipped++;
              }
              remaining = fileSize;
              skipAfter = padded - fileSize;
              if (remaining > 0) {
                state = "DATA";
              } else {
                closeFd();
                state = skipAfter > 0 ? "SKIP" : "HEADER";
              }
            } else {
              skipAfter = padded;
              state = skipAfter > 0 ? "SKIP" : "HEADER";
            }
          }
        } else if (state === "META") {
          if (buf.length === 0) break;
          const n = Math.min(remaining, buf.length);
          metaChunks.push(Buffer.from(buf.subarray(0, n)));
          buf = buf.length > n ? buf.subarray(n) : Buffer.alloc(0);
          remaining -= n;
          if (remaining === 0) {
            const mb = Buffer.concat(metaChunks);
            metaChunks = [];
            if (metaType === "x") parsePax(mb);
            else if (metaType === "L") gnuLongPath = mb.toString("utf8").replace(/\0+$/, "");
            state = skipAfter > 0 ? "SKIP" : "HEADER";
          }
        } else if (state === "DATA") {
          if (buf.length === 0) break;
          const n = Math.min(remaining, buf.length);
          if (fd !== null) fs.writeSync(fd, buf.subarray(0, n));
          buf = buf.length > n ? buf.subarray(n) : Buffer.alloc(0);
          remaining -= n;
          if (remaining === 0) {
            closeFd();
            state = skipAfter > 0 ? "SKIP" : "HEADER";
          }
        } else if (state === "SKIP") {
          if (buf.length === 0) break;
          const n = Math.min(skipAfter, buf.length);
          buf = buf.length > n ? buf.subarray(n) : Buffer.alloc(0);
          skipAfter -= n;
          if (skipAfter === 0) state = "HEADER";
        }
      }
    };

    const gunzip = zlib.createGunzip();
    const webStream = Readable.fromWeb(res.body);

    const onError = (err) => {
      closeFd();
      reject(err);
    };

    webStream.on("error", onError);
    gunzip.on("error", onError);
    gunzip.on("data", (chunk) => {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        processBuf();
      } catch (err) {
        gunzip.destroy(err);
      }
    });
    gunzip.on("end", () => {
      closeFd();
      console.log(`[Init] minecraft-data 瘦身解压完成：保留 ${kept} 个文件，跳过 ${skipped} 个冗余文件`);
      resolve();
    });

    webStream.pipe(gunzip);
  });
}

function dumpNpmDebugLog(cacheDir) {
  try {
    const logsDir = path.join(cacheDir, "_logs");
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir).filter((f) => f.endsWith(".log")).sort();
    if (!files.length) return;
    const content = fs.readFileSync(path.join(logsDir, files[files.length - 1]), "utf8");
    const lines = content.trim().split("\n");
    console.error("[Init] ===== npm 错误日志末尾 =====");
    console.error(lines.slice(-30).join("\n"));
    console.error("[Init] ============================");
  } catch (_) {}
}

function pruneNodeModules(dir) {
  if (!fs.existsSync(dir)) return;
  const junkDirs = new Set(["test", "tests", "__tests__", "doc", "docs", "example", "examples", ".github"]);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (junkDirs.has(entry.name.toLowerCase())) {
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        pruneNodeModules(full);
      }
    } else if (
      entry.name.endsWith(".map") ||
      entry.name.endsWith(".d.ts") ||
      entry.name.endsWith(".md") ||
      entry.name.toUpperCase().startsWith("LICENSE")
    ) {
      try {
        fs.unlinkSync(full);
      } catch (_) {}
    }
  }
}

async function ensureRuntime() {
  if (
    fs.existsSync(READY_FLAG) &&
    fs.readFileSync(READY_FLAG, "utf8").trim() === RUNTIME_SIGNATURE &&
    fs.existsSync(path.join(RUNTIME_DIR, "node_modules", "mineflayer"))
  ) {
    return require(path.join(RUNTIME_DIR, "node_modules", "mineflayer"));
  }

  console.log("[Init] 引导脚本 v5 启动，开始执行瘦身依赖安装...");
  logDiskSpace();

  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  fs.rmSync("/tmp/.npm-mc-cache", { recursive: true, force: true });
  fs.rmSync("/tmp/.npm", { recursive: true, force: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  const cfgVer = config.server && config.server.version ? config.server.version.trim() : "";
  const targetVer = cfgVer || (await pingServerVersion(config.server && config.server.ip, config.server && config.server.port));
  console.log(`[Init] 目标 MC 版本识别: ${targetVer || "未探测到，将使用预设版本"}`);

  const meta = await fetchJson("https://registry.npmjs.org/minecraft-data/latest");
  const allowedPcDirs = await buildAllowedPcDirs(meta.version, targetVer);

  console.log(`[Init] 正在流式下载并瘦身 minecraft-data@${meta.version}...`);
  await downloadAndExtractSlimMcData(meta.dist.tarball, SLIM_MC_DATA_DIR, allowedPcDirs);

  // 移除 slim-mc-data 中的构建脚本，避免 npm 重新扫描已删除的旧版本目录
  const slimPkgPath = path.join(SLIM_MC_DATA_DIR, "package.json");
  if (fs.existsSync(slimPkgPath)) {
    const slimPkg = JSON.parse(fs.readFileSync(slimPkgPath, "utf8"));
    delete slimPkg.scripts;
    fs.writeFileSync(slimPkgPath, JSON.stringify(slimPkg, null, 2));
  }

  const runtimePkg = {
    name: "mc-runtime",
    private: true,
    dependencies: {
      "minecraft-data": "file:./slim-mc-data",
      mineflayer: "^4.34.0",
    },
    overrides: {
      "minecraft-data": "$minecraft-data",
    },
  };
  fs.writeFileSync(path.join(RUNTIME_DIR, "package.json"), JSON.stringify(runtimePkg, null, 2));

  // 缓存与临时目录全部放到 /app/runtime 内，完全绕开 32MB 的 /tmp
  const npmCacheDir = path.join(RUNTIME_DIR, ".npm-cache");
  const npmTmpDir = path.join(RUNTIME_DIR, ".npm-tmp");
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.mkdirSync(npmTmpDir, { recursive: true });

  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    const low = key.toLowerCase();
    if (low === "npm_config_cache" || low === "npm_config_tmp" || low === "npm_config_omit") {
      delete childEnv[key];
    }
  }
  childEnv.HOME = npmTmpDir;
  childEnv.TMPDIR = npmTmpDir;
  childEnv.TEMP = npmTmpDir;
  childEnv.TMP = npmTmpDir;
  childEnv.npm_config_cache = npmCacheDir;
  childEnv.NPM_CONFIG_CACHE = npmCacheDir;

  console.log("[Init] 正在安装其余轻量依赖（已跳过构建脚本与 peer 依赖）...");
  let res;
  try {
    res = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=optional",
        "--omit=peer",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--no-update-notifier",
        "--prefer-online",
        "--cache",
        npmCacheDir,
        "--loglevel=warn",
      ],
      {
        cwd: RUNTIME_DIR,
        stdio: "inherit",
        env: childEnv,
      }
    );

    if (res.error) {
      throw res.error;
    }
    if (res.status !== 0) {
      dumpNpmDebugLog(npmCacheDir);
      throw new Error(`npm install 失败，退出码: ${res.status}`);
    }
  } finally {
    fs.rmSync(npmCacheDir, { recursive: true, force: true });
    fs.rmSync(npmTmpDir, { recursive: true, force: true });
  }

  pruneNodeModules(path.join(RUNTIME_DIR, "node_modules"));
  fs.writeFileSync(READY_FLAG, RUNTIME_SIGNATURE);
  console.log("[Init] 瘦身依赖安装完成！");
  logDiskSpace();

  return require(path.join(RUNTIME_DIR, "node_modules", "mineflayer"));
}

// ==================== 第二部分：挂机机器人与拟人防检测核心 ====================

function startBotApp(mineflayer) {
  let bot = null;
  let attempts = 0;
  let isReconnecting = false;
  let isPlannedDisconnect = false;
  let wasThrottled = false;
  let isEating = false;
  let spawnAnchor = null;

  const activeTimers = new Set();

  const DANGEROUS_BLOCKS = new Set([
    "lava",
    "flowing_lava",
    "fire",
    "soul_fire",
    "cactus",
    "magma_block",
    "sweet_berry_bush",
    "campfire",
    "soul_campfire",
  ]);
  const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);

  const randomInt = (min, max) => {
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return Math.floor(Math.random() * (high - low + 1)) + low;
  };
  const randomFloat = (min, max) => Math.random() * (max - min) + min;
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

  const addTimeout = (fn, ms) => {
    const id = setTimeout(() => {
      activeTimers.delete(id);
      fn();
    }, ms);
    activeTimers.add(id);
    return id;
  };

  const clearAllTimers = () => {
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
  };

  const isBotReady = () => Boolean(bot && bot.entity && bot.entity.position);

  const resetControls = () => {
    if (!bot || typeof bot.setControlState !== "function") return;
    for (const s of ["forward", "back", "left", "right", "jump", "sneak", "sprint"]) {
      try {
        bot.setControlState(s, false);
      } catch (_) {}
    }
  };

  function shortestAngleDelta(from, to) {
    let diff = (to - from) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  // 分段平滑转头（模拟鼠标自然移动）
  function smoothLook(targetYaw, targetPitch, steps = 6, stepMs = 55, onDone) {
    if (!isBotReady()) return;
    const startYaw = bot.entity.yaw;
    const startPitch = bot.entity.pitch;
    const dYaw = shortestAngleDelta(startYaw, targetYaw);
    const dPitch = targetPitch - startPitch;
    let step = 0;

    function next() {
      if (!isBotReady()) return;
      step++;
      const p = easeInOut(step / steps);
      const jitter = step < steps ? randomFloat(-0.015, 0.015) : 0;
      const yaw = startYaw + dYaw * p + jitter;
      const pitch = Math.max(-1.35, Math.min(1.35, startPitch + dPitch * p));
      try {
        Promise.resolve(bot.look(yaw, pitch, false)).catch(() => {});
      } catch (_) {}

      if (step < steps) {
        addTimeout(next, Math.max(25, stepMs + randomInt(-15, 25)));
      } else if (typeof onDone === "function") {
        onDone();
      }
    }
    next();
  }

  // 轻量地形安全检测（防掉坑、防岩浆、防水）
  function isDirectionSafe(yaw) {
    if (!isBotReady()) return false;
    try {
      const pos = bot.entity.position;
      const dx = -Math.sin(yaw) * 1.25;
      const dz = -Math.cos(yaw) * 1.25;
      const feet = bot.blockAt(pos.offset(dx, 0, dz));
      const head = bot.blockAt(pos.offset(dx, 1, dz));
      const g1 = bot.blockAt(pos.offset(dx, -1, dz));
      const g2 = bot.blockAt(pos.offset(dx, -2, dz));

      if (!feet || !head || !g1 || !g2) return false;
      if (DANGEROUS_BLOCKS.has(feet.name) || DANGEROUS_BLOCKS.has(head.name)) return false;
      if (DANGEROUS_BLOCKS.has(g1.name) || g1.name === "water" || g1.name === "flowing_water") return false;
      if (AIR_BLOCKS.has(g1.name) && AIR_BLOCKS.has(g2.name)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  // 锚点有限半径内自然随机走动
  function doRandomWalk() {
    if (!isBotReady() || isEating) return;
    const moveCfg = (config.behavior && config.behavior.movement) || {};
    if (moveCfg.enabled === false) return;

    const maxRadius = moveCfg.maxRadius || 6;
    const pos = bot.entity.position;
    let targetYaw = null;

    if (spawnAnchor && pos.distanceTo(spawnAnchor) > maxRadius) {
      const backYaw = Math.atan2(-(spawnAnchor.x - pos.x), -(spawnAnchor.z - pos.z)) + randomFloat(-0.3, 0.3);
      if (isDirectionSafe(backYaw)) targetYaw = backYaw;
    }

    if (targetYaw === null) {
      for (let i = 0; i < 4; i++) {
        const candidate = bot.entity.yaw + randomFloat(-2.2, 2.2);
        if (isDirectionSafe(candidate)) {
          targetYaw = candidate;
          break;
        }
      }
    }

    if (targetYaw === null) {
      smoothLook(bot.entity.yaw + randomFloat(-1.2, 1.2), randomFloat(-0.3, 0.3));
      return;
    }

    const walkMs = randomInt(500, 1700);
    const shouldSprint = Math.random() < 0.2;
    const shouldJump = Math.random() < 0.22;
    const strafe = Math.random();

    smoothLook(targetYaw, randomFloat(-0.2, 0.2), randomInt(4, 7), randomInt(45, 70), () => {
      if (!isBotReady() || isEating) return;
      try {
        bot.setControlState("forward", true);
        if (shouldSprint) bot.setControlState("sprint", true);
        if (strafe < 0.18) bot.setControlState("left", true);
        else if (strafe < 0.36) bot.setControlState("right", true);

        if (shouldJump) {
          addTimeout(() => {
            if (!isBotReady()) return;
            try {
              bot.setControlState("jump", true);
              addTimeout(() => bot && bot.setControlState("jump", false), randomInt(180, 320));
            } catch (_) {}
          }, randomInt(120, Math.max(180, walkMs - 320)));
        }

        addTimeout(resetControls, walkMs);
      } catch (_) {}
    });
  }

  // 自然注视 8 格内附近玩家或生物
  function lookAtNearbyEntity() {
    if (!isBotReady()) return false;
    try {
      const pos = bot.entity.position;
      const list = Object.values(bot.entities).filter(
        (e) =>
          e &&
          e.position &&
          e.id !== bot.entity.id &&
          (e.type === "player" || e.type === "mob") &&
          pos.distanceTo(e.position) <= 8
      );
      if (!list.length) return false;

      const t = list[randomInt(0, list.length - 1)];
      const dx = t.position.x - pos.x;
      const dy = t.position.y + 1.2 - (pos.y + 1.62);
      const dz = t.position.z - pos.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      smoothLook(Math.atan2(-dx, -dz), Math.atan2(dy, dist), randomInt(5, 8), randomInt(45, 75));
      return true;
    } catch (_) {
      return false;
    }
  }

  function startWaterGuard() {
    const check = () => {
      if (!isBotReady()) return;
      try {
        if (bot.entity.isInWater) {
          bot.setControlState("jump", true);
          addTimeout(() => {
            if (bot && (!bot.entity || !bot.entity.isInWater)) bot.setControlState("jump", false);
          }, 500);
        }
      } catch (_) {}
      addTimeout(check, 1200);
    };
    addTimeout(check, 1500);
  }

  async function tryAutoEat() {
    if (!isBotReady() || isEating) return;
    if (config.behavior && config.behavior.autoEat === false) return;
    if (typeof bot.food !== "number" || bot.food >= 16) return;

    try {
      const foodsByName = bot.registry && bot.registry.foodsByName;
      const food = bot.inventory.items().find((i) => i && ((foodsByName && foodsByName[i.name]) || i.foodPoints > 0));
      if (!food) return;
      isEating = true;
      resetControls();
      await bot.equip(food, "hand");
      await bot.consume();
    } catch (_) {
    } finally {
      isEating = false;
    }
  }

  function performRandomAction() {
    if (!isBotReady() || isEating) return;
    const roll = Math.random();

    if (roll < 0.28) {
      doRandomWalk();
    } else if (roll < 0.5) {
      smoothLook(bot.entity.yaw + randomFloat(-1.6, 1.6), randomFloat(-0.45, 0.35), randomInt(4, 8), randomInt(50, 90));
    } else if (roll < 0.64) {
      if (!lookAtNearbyEntity()) smoothLook(bot.entity.yaw + randomFloat(-1.0, 1.0), randomFloat(-0.3, 0.3));
    } else if (roll < 0.75) {
      try {
        bot.setControlState("sneak", true);
        addTimeout(() => bot && bot.setControlState("sneak", false), randomInt(350, 1300));
      } catch (_) {}
    } else if (roll < 0.84) {
      try {
        const cur = typeof bot.quickBarSlot === "number" ? bot.quickBarSlot : 0;
        const next = Math.random() < 0.6 ? (cur + (Math.random() < 0.5 ? 1 : 8)) % 9 : randomInt(0, 8);
        bot.setQuickBarSlot(next);
      } catch (_) {}
    } else if (roll < 0.9) {
      try {
        bot.swingArm();
      } catch (_) {}
    }
  }

  function scheduleNextAction() {
    if (!isBotReady()) return;
    const cfg = (config.behavior && config.behavior.actionIntervalSec) || {};
    const minMs = (cfg.min || 7) * 1000;
    const maxMs = (cfg.max || 32) * 1000;
    const r = Math.random();
    const delay = r < 0.12 ? randomInt(1800, 4500) : r < 0.24 ? randomInt(35000, 75000) : randomInt(minMs, maxMs);

    addTimeout(() => {
      if (!isBotReady()) return;
      performRandomAction();
      scheduleNextAction();
    }, delay);
  }

  // 定时主动下线并在 2 分钟内重连
  function scheduleSessionLeave() {
    const s = (config.behavior && config.behavior.session) || {};
    if (!s.enabled) return;

    const minMs = Math.max(5, s.minOnlineMin || 25) * 60000;
    const maxMs = Math.max(minMs, (s.maxOnlineMin || 55) * 60000);
    const onlineMs = randomInt(minMs, maxMs);
    console.log(`[Session] 本次预计在线 ${(onlineMs / 60000).toFixed(1)} 分钟后短暂下线`);

    addTimeout(() => {
      if (!bot) return;
      console.log("[Session] 到达计划时长，主动下线休息...");
      isPlannedDisconnect = true;
      resetControls();
      try {
        bot.quit("session_break");
      } catch (_) {
        try {
          bot.end();
        } catch (__) {}
      }

      addTimeout(() => {
        if (isPlannedDisconnect && !isReconnecting) {
          if (bot) {
            try {
              bot.removeAllListeners();
              bot.end();
            } catch (_) {}
            bot = null;
          }
          scheduleReconnect();
        }
      }, 5000);
    }, onlineMs);
  }

  function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    clearAllTimers();
    isEating = false;

    if (isPlannedDisconnect) {
      isPlannedDisconnect = false;
      attempts = 0;
      const s = (config.behavior && config.behavior.session) || {};
      const minSec = Math.max(10, Math.min(s.minOfflineSec || 35, 110));
      const maxSec = Math.max(minSec, Math.min(s.maxOfflineSec || 105, 110));
      const restMs = randomInt(minSec * 1000, maxSec * 1000);
      console.log(`[Session] 计划休息 ${(restMs / 1000).toFixed(0)}s 后重连`);
      addTimeout(() => {
        isReconnecting = false;
        createBot();
      }, restMs);
      return;
    }

    if (wasThrottled) {
      wasThrottled = false;
      const delay = randomInt(60000, 100000);
      console.log(`[Bot] 触发连接限流，${(delay / 1000).toFixed(0)}s 后重连`);
      addTimeout(() => {
        isReconnecting = false;
        createBot();
      }, delay);
      return;
    }

    attempts++;
    const base = (config.utils && config.utils["auto-reconnect-delay"]) || 5000;
    const max = (config.utils && config.utils["max-reconnect-delay"]) || 60000;
    const delay = Math.min(base * Math.pow(2, attempts - 1), max) + randomInt(1000, 4000);
    console.log(`[Bot] ${(delay / 1000).toFixed(1)}s 后重连 (第 #${attempts} 次)`);
    addTimeout(() => {
      isReconnecting = false;
      createBot();
    }, delay);
  }

  function createBot() {
    clearAllTimers();
    isEating = false;

    if (bot) {
      try {
        resetControls();
        bot.removeAllListeners();
        bot.end();
      } catch (_) {}
      bot = null;
    }

    const host = config.server && config.server.ip;
    const port = Number(config.server && config.server.port) || 25565;
    const version = config.server && config.server.version && config.server.version.trim() !== ""
      ? config.server.version.trim()
      : false;

    if (!host) {
      console.log("[Bot] 错误：settings.json 中未填写 server.ip");
      return;
    }

    console.log(`[Bot] 正在连接 ${host}:${port} (玩家: ${config["bot-account"].username})...`);

    try {
      bot = mineflayer.createBot({
        username: config["bot-account"].username,
        password: config["bot-account"].password || undefined,
        auth: config["bot-account"].type || "offline",
        host,
        port,
        version,
        hideErrors: false,
        checkTimeoutInterval: 600000,
      });
    } catch (err) {
      console.log(`[Bot] 创建实例失败: ${err.message}`);
      scheduleReconnect();
      return;
    }

    let spawnStarted = false;
    const watchdog = addTimeout(() => {
      if (!spawnStarted) {
        console.log("[Bot] 连接超时（90s 未进入游戏），准备重试...");
        if (bot) {
          try {
            bot.removeAllListeners();
            bot.end();
          } catch (_) {}
          bot = null;
        }
        scheduleReconnect();
      }
    }, 90000);

    bot.once("spawn", () => {
      spawnStarted = true;
      clearTimeout(watchdog);
      activeTimers.delete(watchdog);

      attempts = 0;
      isReconnecting = false;
      isPlannedDisconnect = false;
      spawnAnchor = bot.entity.position.clone();

      console.log(
        `[Bot] 成功进服 (MC ${bot.version})，锚点: (${Math.floor(spawnAnchor.x)}, ${Math.floor(spawnAnchor.y)}, ${Math.floor(spawnAnchor.z)})`
      );

      if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
        const pwd = config.utils["auto-auth"].password;
        addTimeout(() => isBotReady() && bot.chat(`/login ${pwd}`), randomInt(2500, 4500));
      }

      addTimeout(() => {
        scheduleNextAction();
        startWaterGuard();
        scheduleSessionLeave();
      }, randomInt(3000, 7000));
    });

    bot.on("respawn", () => {
      addTimeout(() => {
        if (isBotReady()) {
          spawnAnchor = bot.entity.position.clone();
          console.log("[Bot] 已重生，锚点已更新");
        }
      }, 1500);
    });

    bot.on("health", tryAutoEat);

    bot.on("kicked", (reason) => {
      const text = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
      console.log(`[Bot] 被踢出: ${text}`);
      const lower = text.toLowerCase();
      if (lower.includes("throttl") || lower.includes("wait") || lower.includes("too fast")) {
        wasThrottled = true;
      }
    });

    bot.on("error", (err) => console.log(`[Bot] 连接错误: ${err.message}`));
    bot.on("end", (reason) => {
      console.log(`[Bot] 连接断开: ${reason || "socketClosed"}`);
      scheduleReconnect();
    });
  }

  process.on("uncaughtException", (err) => {
    console.log(`[FATAL] 未捕获异常: ${err.message}`);
    scheduleReconnect();
  });

  process.on("unhandledRejection", (reason) => {
    console.log(`[FATAL] 未处理的 Promise 拒绝: ${reason}`);
  });

  createBot();
}

(async () => {
  try {
    const mineflayer = await ensureRuntime();
    startBotApp(mineflayer);
  } catch (err) {
    console.error(`[Init] 启动失败: ${err.stack || err.message}`);
    process.exit(1);
  }
})();