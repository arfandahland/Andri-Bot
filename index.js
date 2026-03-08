const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
const QRCode = require("qrcode");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER || "";
const OWNER_PASSWORD = "BOTPINTAR";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

let currentQR = null;
let botStatus = "starting";
let sock = null;

// =============================================
// WEB SERVER — tampilkan QR di browser
// =============================================
const server = http.createServer(async (req, res) => {
  if (req.url === "/") {
    if (botStatus === "connected") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Andri Logistik Bot</title>
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#e8f5e9}
        .box{background:white;border-radius:16px;padding:30px;max-width:400px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.1)}</style>
      </head><body><div class="box">
        <div style="font-size:60px">✅</div>
        <h2 style="color:#2e7d32">Andri Logistik Bot Aktif!</h2>
        <p style="color:#555">Bot sudah terhubung ke WhatsApp dan siap melayani pelanggan 24/7 🚢</p>
      </div></body></html>`);
    } else if (currentQR) {
      try {
        const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <meta http-equiv="refresh" content="30">
          <title>Scan QR - Andri Logistik Bot</title>
          <style>body{font-family:sans-serif;text-align:center;padding:20px;background:#fff8e1}
          .box{background:white;border-radius:16px;padding:24px;max-width:380px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.15)}
          img{border-radius:12px;border:3px solid #ff6b35}
          .warn{background:#fff3e0;border-radius:8px;padding:10px;margin-top:16px;color:#e65100;font-size:13px}</style>
        </head><body><div class="box">
          <div style="font-size:40px">📱</div>
          <h2 style="color:#e65100">Scan QR Code ini!</h2>
          <img src="${qrImage}" width="260" height="260" />
          <div class="warn">⚠️ QR berlaku 60 detik<br>Halaman auto-refresh tiap 30 detik</div>
          <p style="color:#888;font-size:12px;margin-top:12px">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Scan</p>
        </div></body></html>`);
      } catch(e) { res.writeHead(500); res.end("Error"); }
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
        <meta http-equiv="refresh" content="5">
        <title>Andri Logistik Bot</title>
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#e3f2fd}
        .box{background:white;border-radius:16px;padding:30px;max-width:400px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.1)}</style>
      </head><body><div class="box">
        <div style="font-size:50px">⏳</div>
        <h2 style="color:#1565c0">Bot sedang starting...</h2>
        <p>Auto-refresh tiap 5 detik. Tunggu sebentar!</p>
      </div></body></html>`);
    }
  } else { res.writeHead(404); res.end("Not found"); }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🌐 Web server aktif di port ${PORT}`));

// =============================================
// DATABASE
// =============================================
const DB_PATH = "/tmp/andribot";
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

function loadDB(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "{}");
  try { return JSON.parse(fs.readFileSync(file)); } catch(e) { return {}; }
}
function saveDB(name, data) {
  fs.writeFileSync(path.join(DB_PATH, `${name}.json`), JSON.stringify(data, null, 2));
}

let customQA = loadDB("custom_qa");
let customerData = loadDB("customers");
let orderTracking = loadDB("orders");
let chatSummaries = loadDB("summaries");

// =============================================
// SYSTEM PROMPT
// =============================================
function buildSystemPrompt() {
  const custom = Object.entries(customQA).map(([q,a]) => `Q: ${q}\nA: ${a}`).join("\n\n");
  return `Kamu adalah "Andra" — asisten virtual WhatsApp untuk "Andri Logistik", jasa pengiriman paket Surabaya ke Maluku Utara.

=== INFORMASI BISNIS ===
- Rute: Surabaya → Ternate, Tidore, Sofifi, Tobelo, Sanana, Bacan, Morotai, seluruh Maluku Utara
- Estimasi: 5–10 hari kerja
- Tarif: mulai Rp 25.000/kg | Volumetrik: (PxLxT)÷5000 kg
- Minimal: 1 kg | Jadwal: Senin & Kamis
- Jam: Senin–Sabtu 08.00–20.00 WIB
- Admin: 0812-3456-7890
- Agen Surabaya: Jl. Perak Barat No. 45 (dekat Pelabuhan Tanjung Perak)
- Bayar: BCA, BNI, Mandiri, GoPay, OVO, Dana, QRIS
- Extra: packing kayu +Rp 30.000, bubble wrap +Rp 10.000, asuransi tersedia

=== PENGETAHUAN CUSTOM ===
${custom || "Belum ada."}

=== BAHASA ===
Deteksi bahasa pelanggan, balas dengan bahasa SAMA:
- Ternate: ngana(kamu), torang(kita), seng(tidak), dang(sudah), pi(pergi)
- Tidore: ngoni(kalian), gita(kita), nyawa(kamu)
- Makassar: ki(sopan), iye(iya), tena(tidak), eroka(mau), sikamma(semua)
- Manado: ngana(kamu), torang(kita), so(sudah), nda(tidak), kang(kan)
- Ambon: ale(kamu), beta(saya), su(sudah), tra(tidak), katong(kita), pung(punya)

=== ATURAN ===
- Ramah & hangat seperti teman, max 5 kalimat
- Emoji natural, jangan pakai *tebal* atau _miring_
- Ingat konteks percakapan sebelumnya`;
}

// =============================================
// KIRIM QR KE WA OWNER
// =============================================
async function kirimQRKeOwner(qrData) {
  if (!OWNER_NUMBER || !sock) return;
  try {
    const qrImage = await QRCode.toBuffer(qrData, { width: 400, margin: 2 });
    const ownerJid = `${OWNER_NUMBER}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, {
      image: qrImage,
      caption: "🔐 Scan QR Code ini untuk menghubungkan bot ke WhatsApp!\n\nBuka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Scan\n\n⚠️ QR berlaku 60 detik!"
    });
    console.log("✅ QR Code terkirim ke WhatsApp owner!");
  } catch(e) {
    console.log("📱 QR siap di browser URL Railway kamu!");
  }
}

// =============================================
// VOLUMETRIK
// =============================================
function parseVolumetrik(text) {
  const m = text.match(/(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)/i);
  return m ? { p:+m[1], l:+m[2], t:+m[3] } : null;
}

// =============================================
// CUSTOMER DATA
// =============================================
function saveCustomer(phone) {
  if (!customerData[phone]) customerData[phone] = { phone, firstContact: new Date().toISOString(), totalChats: 0, lastChat: null };
  customerData[phone].totalChats++;
  customerData[phone].lastChat = new Date().toISOString();
  saveDB("customers", customerData);
}

// =============================================
// GEMINI AI
// =============================================
const chatHistory = {};
async function tanyaGemini(phone, pesan) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: buildSystemPrompt(),
    generationConfig: { maxOutputTokens: 500, temperature: 0.85 },
  });
  if (!chatHistory[phone]) chatHistory[phone] = [];
  const chat = model.startChat({ history: chatHistory[phone] });
  const result = await chat.sendMessage(pesan);
  const balasan = result.response.text();
  chatHistory[phone].push({ role:"user", parts:[{text:pesan}] });
  chatHistory[phone].push({ role:"model", parts:[{text:balasan}] });
  if (chatHistory[phone].length > 30) chatHistory[phone].splice(0, 2);
  return balasan;
}

// =============================================
// AUTO RINGKASAN
// =============================================
async function buatRingkasan(phone) {
  const hist = chatHistory[phone] || [];
  if (hist.length < 4) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const text = hist.map(h => `${h.role==="user"?"Pelanggan":"Bot"}: ${h.parts[0].text}`).join("\n");
    const r = await model.generateContent(`Buat ringkasan 3 poin dari percakapan ini:\n${text}\n\nFormat:\n• Kebutuhan: ...\n• Info diberikan: ...\n• Tindak lanjut: ...`);
    const summary = r.response.text();
    chatSummaries[phone] = { summary, time: new Date().toISOString() };
    saveDB("summaries", chatSummaries);
    return summary;
  } catch(e) { return null; }
}

// =============================================
// STATE
// =============================================
const userState = {};
const liveAgentSessions = {};

function pesanHelp() {
  return `🤖 PANEL OWNER — Andri Logistik Bot v4

📚 TRAINING:
latih | pertanyaan | jawaban
hapus | pertanyaan
lihat training

📦 PESANAN:
pesanan | noResi | nama | tujuan | status
update | noResi | status baru
lihat pesanan

📊 INFO:
statistik
data pelanggan
ringkasan | 628xxx

📣 KIRIM PESAN:
broadcast | isi pesan
followup | 628xxx | pesan

❌ KELUAR: keluar`;
}

// =============================================
// HANDLE OWNER
// =============================================
async function handleOwner(pengirim, text, ownerJid) {
  if (text === OWNER_PASSWORD) {
    userState[pengirim] = { mode: "owner" };
    await sock.sendMessage(pengirim, { text: pesanHelp() });
    return true;
  }
  if (userState[pengirim]?.mode !== "owner") return false;

  if (text === "keluar") {
    delete userState[pengirim];
    await sock.sendMessage(pengirim, { text: "✅ Keluar dari mode Owner!" });
    return true;
  }
  if (text.startsWith("latih |")) {
    const [,q,a] = text.split("|").map(s=>s.trim());
    if (q&&a) { customQA[q.toLowerCase()]=a; saveDB("custom_qa",customQA); await sock.sendMessage(pengirim,{text:`✅ Bot dilatih!\n❓ ${q}\n💬 ${a}`}); }
    else await sock.sendMessage(pengirim,{text:"⚠️ Format: latih | pertanyaan | jawaban"});
    return true;
  }
  if (text.startsWith("hapus |")) {
    const q = text.split("|")[1]?.trim().toLowerCase();
    if (q&&customQA[q]) { delete customQA[q]; saveDB("custom_qa",customQA); await sock.sendMessage(pengirim,{text:`✅ Dihapus: ${q}`}); }
    else await sock.sendMessage(pengirim,{text:`❌ Tidak ditemukan: ${q}`});
    return true;
  }
  if (text === "lihat training") {
    const list = Object.entries(customQA);
    await sock.sendMessage(pengirim,{text: list.length ? "📚 Training:\n\n"+list.map(([q,a],i)=>`${i+1}. ❓${q}\n   💬${a}`).join("\n\n") : "📚 Belum ada training."});
    return true;
  }
  if (text === "statistik") {
    await sock.sendMessage(pengirim,{text:`📊 Statistik Bot:\n\n👥 Pelanggan: ${Object.keys(customerData).length}\n📦 Pesanan: ${Object.keys(orderTracking).length}\n📚 Training: ${Object.keys(customQA).length}\n🕐 ${new Date().toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}`});
    return true;
  }
  if (text === "data pelanggan") {
    const list = Object.values(customerData).slice(-10);
    await sock.sendMessage(pengirim,{text: list.length ? "👥 Pelanggan:\n\n"+list.map((c,i)=>`${i+1}. ${c.phone}\n   Chat: ${c.totalChats}x\n   Terakhir: ${new Date(c.lastChat).toLocaleDateString("id-ID")}`).join("\n\n") : "👥 Belum ada data."});
    return true;
  }
  if (text.startsWith("pesanan |")) {
    const [,no,nama,tujuan,status] = text.split("|").map(s=>s.trim());
    if (no&&nama&&tujuan&&status) { orderTracking[no]={no,nama,tujuan,status,updatedAt:new Date().toISOString()}; saveDB("orders",orderTracking); await sock.sendMessage(pengirim,{text:`✅ Pesanan ditambah!\n📦 ${no}\n👤 ${nama}\n📍 ${tujuan}\n🔄 ${status}`}); }
    else await sock.sendMessage(pengirim,{text:"⚠️ Format: pesanan | noResi | nama | tujuan | status"});
    return true;
  }
  if (text === "lihat pesanan") {
    const list = Object.values(orderTracking).slice(-10);
    await sock.sendMessage(pengirim,{text: list.length ? "📦 Pesanan:\n\n"+list.map((o,i)=>`${i+1}. ${o.no}\n   👤${o.nama} → 📍${o.tujuan}\n   🔄${o.status}`).join("\n\n") : "📦 Belum ada pesanan."});
    return true;
  }
  if (text.startsWith("update |")) {
    const [,no,status] = text.split("|").map(s=>s.trim());
    if (orderTracking[no]) { orderTracking[no].status=status; orderTracking[no].updatedAt=new Date().toISOString(); saveDB("orders",orderTracking); await sock.sendMessage(pengirim,{text:`✅ ${no} → ${status}`}); }
    else await sock.sendMessage(pengirim,{text:`❌ Resi ${no} tidak ditemukan.`});
    return true;
  }
  if (text.startsWith("broadcast |")) {
    const pesan = text.split("|")[1]?.trim();
    const customers = Object.keys(customerData);
    if (!pesan) { await sock.sendMessage(pengirim,{text:"⚠️ Format: broadcast | pesan"}); return true; }
    await sock.sendMessage(pengirim,{text:`📣 Broadcast ke ${customers.length} pelanggan...`});
    let ok=0;
    for (const ph of customers) {
      try { await sock.sendMessage(`${ph}`,{text:`📢 Info Andri Logistik:\n\n${pesan}`}); ok++; await new Promise(r=>setTimeout(r,2000)); } catch(e){}
    }
    await sock.sendMessage(pengirim,{text:`✅ Selesai! ${ok}/${customers.length} terkirim.`});
    return true;
  }
  if (text.startsWith("followup |")) {
    const [,phone,pesan] = text.split("|").map(s=>s.trim());
    const target = `${phone?.replace(/\D/g,"")}@s.whatsapp.net`;
    try { await sock.sendMessage(target,{text:`🚢 Andri Logistik\n\n${pesan}\n\nInfo: 0812-3456-7890`}); await sock.sendMessage(pengirim,{text:`✅ Terkirim ke ${phone}`}); }
    catch(e) { await sock.sendMessage(pengirim,{text:`❌ Gagal kirim ke ${phone}`}); }
    return true;
  }
  if (text.startsWith("ringkasan |")) {
    const phone = text.split("|")[1]?.trim().replace(/\D/g,"");
    const s = chatSummaries[`${phone}@s.whatsapp.net`];
    await sock.sendMessage(pengirim,{text: s ? `📝 Ringkasan ${phone}:\n\n${s.summary}\n\n🕐${new Date(s.time).toLocaleString("id-ID")}` : `❌ Belum ada ringkasan untuk ${phone}.`});
    return true;
  }
  return false;
}

// =============================================
// HANDLE CUSTOMER
// =============================================
async function handleCustomer(pengirim, isiPesan, ownerJid) {
  saveCustomer(pengirim);

  if (liveAgentSessions[pengirim]) {
    if (["selesai","keluar","exit"].includes(isiPesan.toLowerCase())) {
      delete liveAgentSessions[pengirim];
      await sock.sendMessage(pengirim,{text:"✅ Sesi live agent selesai. Terima kasih! 😊🚢"});
      if (ownerJid) await sock.sendMessage(ownerJid,{text:`ℹ️ Pelanggan ${pengirim} mengakhiri live agent.`});
    } else {
      if (ownerJid) await sock.sendMessage(ownerJid,{text:`💬 Pesan dari pelanggan:\n${pengirim}\n\n${isiPesan}`});
      await sock.sendMessage(pengirim,{text:"📨 Pesanmu sudah diteruskan ke admin. Mohon tunggu! 😊"});
    }
    return;
  }

  if (["live agent","hubungi admin","minta cs","bicara admin","hubungi cs"].some(k=>isiPesan.toLowerCase().includes(k))) {
    liveAgentSessions[pengirim] = true;
    await sock.sendMessage(pengirim,{text:"🙋 Menghubungkan ke admin Andri Logistik...\n\nMohon tunggu ya! 😊\n\n(Ketik 'selesai' untuk kembali ke bot)"});
    if (ownerJid) await sock.sendMessage(ownerJid,{text:`🔔 LIVE AGENT!\nDari: ${pengirim}\nPesan: ${isiPesan}\n\nBalas langsung ke nomor pelanggan!`});
    return;
  }

  const vol = parseVolumetrik(isiPesan);
  if (vol && isiPesan.match(/volum|ukuran|dimensi|cm/i)) {
    const beratVol = Math.round((vol.p*vol.l*vol.t)/5000*10)/10;
    const bm = isiPesan.match(/(\d+(?:\.\d+)?)\s*kg/i);
    const beratAktual = bm ? parseFloat(bm[1]) : 0;
    const beratFinal = Math.max(beratVol, beratAktual);
    await sock.sendMessage(pengirim,{text:`📦 Hasil Hitung Volumetrik:\n\n📐 ${vol.p}×${vol.l}×${vol.t} cm\n⚖️ Berat volumetrik: ${beratVol} kg\n${beratAktual?`⚖️ Berat aktual: ${beratAktual} kg\n`:""}✅ Berat digunakan: ${beratFinal} kg\n💰 Estimasi ongkir: Rp ${(Math.ceil(beratFinal)*25000).toLocaleString("id-ID")}\n\nUntuk tarif pasti hubungi: 0812-3456-7890 😊🚢`});
    return;
  }

  const resiM = isiPesan.match(/\b(AL|ORD)[- ]?(\w+)\b/i);
  if (resiM) {
    const no = resiM[0].toUpperCase();
    const order = orderTracking[no];
    if (order) { await sock.sendMessage(pengirim,{text:`📦 Status ${no}:\n\n👤 ${order.nama}\n📍 ${order.tujuan}\n🔄 ${order.status}\n🕐 ${new Date(order.updatedAt).toLocaleString("id-ID")}\n\nInfo: 0812-3456-7890 😊`}); return; }
  }

  const balasan = await tanyaGemini(pengirim, isiPesan);
  await sock.sendMessage(pengirim, { text: balasan });

  const hist = chatHistory[pengirim]||[];
  if (hist.length > 0 && hist.length % 20 === 0) {
    const summary = await buatRingkasan(pengirim);
    if (summary && ownerJid) await sock.sendMessage(ownerJid,{text:`📝 Auto Ringkasan\nDari: ${pengirim}\n\n${summary}`});
  }

  const cust = customerData[pengirim];
  if (cust?.totalChats === 1 && ownerJid) {
    await sock.sendMessage(ownerJid,{text:`🆕 Pelanggan Baru!\nNomor: ${pengirim}\nPesan: ${isiPesan}`});
  }
}

// =============================================
// JALANKAN BOT
// =============================================
async function jalankanBot() {
  const AUTH_PATH = "/tmp/andribot/auth_info";
  if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: 60000,
    browser: ["Andri Logistik Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      botStatus = "waiting_scan";
      console.log("\n📱 QR Code siap!");
      console.log(`🌐 Buka browser: https://andri-bot-production.up.railway.app`);
      console.log("Atau QR akan dikirim ke WA owner jika OWNER_NUMBER sudah diset\n");
      await kirimQRKeOwner(qr);
    }

    if (connection === "close") {
      currentQR = null;
      botStatus = "reconnecting";
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("🚪 Bot logout! Menghapus sesi...");
        try { fs.rmSync(AUTH_PATH, { recursive: true, force: true }); fs.mkdirSync(AUTH_PATH, { recursive: true }); } catch(e){}
        botStatus = "starting";
        setTimeout(jalankanBot, 3000);
      } else {
        console.log(`🔄 Reconnecting... (code: ${code})`);
        setTimeout(jalankanBot, 5000);
      }
    }

    if (connection === "open") {
      currentQR = null;
      botStatus = "connected";
      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║  ✅ ANDRI LOGISTIK BOT AKTIF!               ║");
      console.log("║  🚢 Siap melayani pelanggan 24/7             ║");
      console.log("║  🌏 6 Bahasa + AI + Training + Live Agent    ║");
      console.log("╚══════════════════════════════════════════════╝\n");

      const ownerJid = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
      if (ownerJid) {
        try {
          await sock.sendMessage(ownerJid, {
            text: `✅ *Andri Logistik Bot Aktif!*\n\n🚢 Bot sudah terhubung dan siap melayani pelanggan 24/7!\n\nKetik *BOTPINTAR* untuk buka panel owner 🤖`
          });
        } catch(e) {}
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) return;
      const pengirim = msg.key.remoteJid;
      if (!pengirim || pengirim.endsWith("@g.us")) return;
      const isiPesan = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
      if (!isiPesan.trim()) return;

      const ownerJid = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
      const isOwner = ownerJid && pengirim === ownerJid;

      console.log(`📩 [${new Date().toLocaleTimeString("id-ID")}] ${isOwner?"👑":"👤"} ${pengirim}: ${isiPesan}`);

      try {
        await sock.readMessages([msg.key]);
        await sock.sendPresenceUpdate("composing", pengirim);

        if (isOwner || userState[pengirim]?.mode === "owner") {
          const handled = await handleOwner(pengirim, isiPesan.trim(), ownerJid);
          if (handled) { await sock.sendPresenceUpdate("paused", pengirim); continue; }
        }

        await handleCustomer(pengirim, isiPesan, ownerJid);
        await sock.sendPresenceUpdate("paused", pengirim);
      } catch(err) {
        console.error("❌ Error:", err.message);
        await sock.sendPresenceUpdate("paused", pengirim).catch(()=>{});
        await sock.sendMessage(pengirim, { text: "Maaf ada gangguan 🙏 Hubungi admin: 0812-3456-7890" }).catch(()=>{});
      }
    }
  });
}

console.log("🚀 Memulai Andri Logistik Bot v4...");
jalankanBot();
