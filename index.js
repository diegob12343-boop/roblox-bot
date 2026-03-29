require("dotenv").config();
const noblox = require("noblox.js");

const CONFIG = {
  cookie: (process.env.ROBLOX_COOKIE || "").replace(/\s+/g, "").trim(),
  groupId: parseInt(process.env.GROUP_ID),
  ownerUserId: parseInt(process.env.OWNER_USER_ID),
  exemptUsers: (process.env.EXEMPT_USERS || "").split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
  // Ranks que podem dar up/rebaixar livremente sem limite de salto
  exemptActorRanks: [224, 254, 255], // ranks que podem dar up/rebaixar livremente
  maxRankJump: parseInt(process.env.MAX_RANK_JUMP) || 1,
  protectedRanks: (process.env.PROTECTED_RANKS || "")
    .split(",").map((r) => parseInt(r.trim())).filter((r) => !isNaN(r)),
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || null,
};

let botUserId = null;
const rankCache = new Map(); // userId -> rank
const upCount = new Map();   // userId -> { count, timer }

function log(type, msg) {
  const icons = { INFO: "ℹ️ ", WARN: "⚠️ ", ACTION: "🔒", ERROR: "❌", OK: "✅" };
  const time = new Date().toLocaleTimeString("pt-BR");
  console.log(`[${time}] ${icons[type] || "  "} [${type}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendDiscordLog(embed) {
  if (!CONFIG.discordWebhook) return;
  try {
    await fetch(CONFIG.discordWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (e) { log("ERROR", `Discord: ${e.message}`); }
}

async function getUsername(userId) {
  try { return await noblox.getUsernameFromId(userId); }
  catch { return `UserID:${userId}`; }
}

// Busca actor com retry — audit log pode demorar a indexar
// Só aceita entradas dos últimos 60 segundos para evitar pegar reversões antigas do bot
async function getActorOfRankChange(targetId, retries = 5, delayMs = 1500) {
  for (let i = 0; i < retries; i++) {
    try {
      const page = await noblox.getAuditLog(CONFIG.groupId, "ChangeRank", null, "Desc", 25);
      const agora = Date.now();
      for (const entry of (page.data || [])) {
        if (Number(entry.description?.TargetId) === Number(targetId)) {
          // Verifica se a entrada é recente (últimos 60s)
          const entryTime = new Date(entry.created).getTime();
          const idadeSegundos = (agora - entryTime) / 1000;
          if (idadeSegundos > 60) {
            log("WARN", `Entrada do audit log muito antiga (${Math.round(idadeSegundos)}s) — ignorando`);
            continue;
          }
          const actorId = Number(entry.actor?.user?.userId);
          if (actorId) return actorId;
        }
      }
    } catch (e) {
      log("WARN", `Audit log erro (tentativa ${i + 1}): ${e.message}`);
    }
    if (i < retries - 1) await sleep(delayMs);
  }
  return null;
}

async function revertRank(userId, username, oldRank, blockedRank, reason) {
  try {
    if (oldRank === undefined || oldRank === blockedRank) return;
    rankCache.set(userId, oldRank);
    await noblox.setRank(CONFIG.groupId, userId, oldRank);
    log("ACTION", `✔ ${username} revertido para rank ${oldRank}. Motivo: ${reason}`);
    await sendDiscordLog({
      title: "🔒 Anti-Raid — Rank Revertido",
      color: 0xff4444,
      fields: [
        { name: "Usuário", value: `${username} (${userId})`, inline: true },
        { name: "Rank bloqueado", value: `${blockedRank}`, inline: true },
        { name: "Revertido para", value: `${oldRank}`, inline: true },
        { name: "Motivo", value: reason, inline: false },
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    log("ERROR", `Falha ao reverter ${username}: ${e.message}`);
  }
}

async function handleRankChange(uid, cachedRank, newRank) {
  const username = await getUsername(uid);
  const jump = newRank - cachedRank;

  log("INFO", `${username} rank ${cachedRank}→${newRank} (salto:${jump}) — buscando actor...`);

  const actorId = await getActorOfRankChange(uid, 5, 1500);
  const actorName = actorId ? await getUsername(actorId) : "Desconhecido";
  log("INFO", `${username} actor: ${actorName} (${actorId})`);

  // Se o actor for o próprio bot, atualiza cache e ignora (foi uma reversão legítima do bot)
  if (actorId && Number(actorId) === Number(botUserId)) {
    log("INFO", `Ação do próprio bot em ${username} — ignorando.`);
    rankCache.set(uid, newRank);
    return;
  }

  // Actor desconhecido mesmo após retries → REVERTE por segurança
  if (!actorId) {
    log("WARN", `Actor desconhecido para ${username} após retries — revertendo por segurança.`);
    await revertRank(uid, username, cachedRank, newRank, "Actor desconhecido — possível raid");
    return;
  }

  // Dono e isentos por userId podem tudo
  const allExemptUsers = [Number(CONFIG.ownerUserId), ...CONFIG.exemptUsers];
  if (allExemptUsers.includes(Number(actorId))) {
    rankCache.set(uid, newRank);
    log("OK", `Isento ${actorName} (${actorId}) agiu — liberado para ${username}.`);
    return;
  }

  // Verifica se o actor tem rank isento (224, 254, 255 podem tudo)
  try {
    const actorRank = await noblox.getRankInGroup(CONFIG.groupId, actorId);
    log("INFO", `Rank do actor ${actorName}: ${actorRank}`);
    if (CONFIG.exemptActorRanks.includes(actorRank)) {
      rankCache.set(uid, newRank);
      log("OK", `Actor ${actorName} rank ${actorRank} isento — liberado para ${username}.`);
      return;
    }
  } catch (e) {
    log("WARN", `Não foi possível checar rank do actor ${actorId}: ${e.message}`);
  }

  // Rebaixamento bloqueado para não-isentos
  if (jump < 0) {
    log("WARN", `RAID! ${actorName} rebaixou ${username} (${cachedRank}→${newRank}). Revertendo...`);
    await revertRank(uid, username, cachedRank, newRank,
      `Rebaixamento por ${actorName} (${actorId}) não permitido`);
    return;
  }

  // Cargo protegido
  if (CONFIG.protectedRanks.includes(newRank)) {
    log("ACTION", `Cargo ${newRank} protegido! ${actorName} tentou promover ${username}. Revertendo...`);
    await revertRank(uid, username, cachedRank, newRank,
      "Cargo protegido — apenas o dono pode conceder");
    return;
  }

  // Conta ups consecutivos na mesma pessoa (reseta após 30s sem novo up)
  const now = Date.now();
  const entry = upCount.get(uid) || { count: 0, lastTime: null };

  // Reseta contagem se o último up foi há mais de 30s
  if (entry.lastTime && now - entry.lastTime > 30_000) {
    entry.count = 0;
  }

  entry.count += 1;
  entry.lastTime = now;
  upCount.set(uid, entry);

  if (entry.count >= 2) {
    log("WARN", `RAID! ${actorName} deu ${entry.count} ups seguidos em ${username}. Revertendo...`);
    upCount.delete(uid);
    await revertRank(uid, username, cachedRank, newRank,
      `${actorName} (${actorId}) deu ${entry.count} ups seguidos — possível raid`);
    return;
  }

  // Legítimo (1º up)
  rankCache.set(uid, newRank);
  log("OK", `${actorName} promoveu ${username}: rank ${cachedRank}→${newRank}`);
}

// Polling por roles em lote — snapshot completo e rápido
async function pollRanks() {
  try {
    const roles = await noblox.getRoles(CONFIG.groupId);

    // Monta snapshot atual: userId -> rank
    const currentSnapshot = new Map();
    for (const role of roles) {
      if (role.rank === 0) continue;
      try {
        const members = await noblox.getPlayers(CONFIG.groupId, role.id);
        for (const member of members) {
          currentSnapshot.set(member.userId, role.rank);
        }
      } catch (e) { /* role vazio, ignora */ }
    }

    // Detecta mudanças comparando com cache
    const changes = [];
    for (const [uid, newRank] of currentSnapshot.entries()) {
      const cachedRank = rankCache.get(uid);
      if (cachedRank === undefined) {
        rankCache.set(uid, newRank); // novo membro
        continue;
      }
      if (cachedRank !== newRank) {
        changes.push({ uid, cachedRank, newRank });
      }
    }

    if (changes.length === 0) return;

    log("INFO", `${changes.length} mudança(s) detectada(s) — processando...`);

    // Processa todas as mudanças em paralelo
    await Promise.all(changes.map(({ uid, cachedRank, newRank }) =>
      handleRankChange(uid, cachedRank, newRank)
    ));

  } catch (e) {
    log("ERROR", `Erro no polling: ${e.message}`);
  }
}

async function loadAllMembers() {
  log("INFO", "Carregando membros do grupo...");
  try {
    const roles = await noblox.getRoles(CONFIG.groupId);
    let total = 0;
    for (const role of roles) {
      if (role.rank === 0) continue;
      try {
        const members = await noblox.getPlayers(CONFIG.groupId, role.id);
        for (const member of members) rankCache.set(member.userId, role.rank);
        total += members.length;
      } catch (e) { }
    }
    log("OK", `${total} membros carregados.`);
  } catch (e) {
    log("ERROR", `Erro ao carregar membros: ${e.message}`);
  }
}

function startPolling() {
  let running = false;
  setInterval(async () => {
    if (running) {
      log("WARN", "Ciclo anterior ainda em andamento — pulando...");
      return;
    }
    running = true;
    try {
      await pollRanks();
    } catch (e) {
      log("ERROR", `Polling falhou: ${e.message}`);
    } finally {
      running = false;
    }
  }, 6_000);
}

async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║      🛡️  BOT ANTI-RAID ROBLOX  🛡️       ║
║         Proteção de cargos ativa         ║
╚══════════════════════════════════════════╝
  `);

  // Debug — mostra o que foi carregado das env vars
  log("INFO", `ROBLOX_COOKIE: ${CONFIG.cookie ? "✅ carregado (" + CONFIG.cookie.length + " chars)" : "❌ VAZIO"}`);
  log("INFO", `GROUP_ID: ${CONFIG.groupId || "❌ VAZIO"}`);
  log("INFO", `OWNER_USER_ID: ${CONFIG.ownerUserId || "❌ VAZIO"}`);

  if (!CONFIG.cookie || CONFIG.cookie === "SEU_COOKIE_AQUI") {
    log("ERROR", "Configure o ROBLOX_COOKIE no painel do Render (Environment Variables)!"); process.exit(1);
  }
  if (!CONFIG.groupId || isNaN(CONFIG.groupId)) {
    log("ERROR", "Configure o GROUP_ID no painel do Render (Environment Variables)!"); process.exit(1);
  }

  log("INFO", "Fazendo login no Roblox...");
  noblox.setOptions({ show_deprecation_warnings: false });
  try {
    await noblox.setCookie(CONFIG.cookie);
    const user = await noblox.getCurrentUser();
    botUserId = user.UserID;
    log("OK", `Logado como: ${user.UserName} (${user.UserID})`);
  } catch (e) {
    log("ERROR", `Falha no login: ${e.message}`); process.exit(1);
  }

  log("INFO", `Cargos protegidos: [${CONFIG.protectedRanks.join(", ")}]`);
  log("INFO", `Salto máximo: ${CONFIG.maxRankJump} cargo`);
  log("INFO", `Dono isento: UserID ${CONFIG.ownerUserId}`);

  await loadAllMembers();

  // Handler global — bot não crasha por ECONNRESET ou outros erros
  process.on("uncaughtException", (e) => {
    log("ERROR", `Erro não capturado: ${e.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    log("ERROR", `Promise rejeitada: ${reason}`);
  });

  log("INFO", "Monitoramento iniciado! Verificando a cada 6 segundos...\n");
  startPolling();
}

// Sobe HTTP imediatamente para o Render marcar como live
// e em paralelo inicia o bot sem depender um do outro
const http = require("http");
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Anti-Raid bot online!");
});

server.listen(PORT, () => {
  log("INFO", `Servidor HTTP ativo na porta ${PORT}`);
  // Inicia o bot APÓS o servidor estar pronto
  main().catch((e) => {
    log("ERROR", `Erro fatal: ${e.message}`);
    process.exit(1);
  });
});
