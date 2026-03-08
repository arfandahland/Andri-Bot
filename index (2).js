const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
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

// QR state untuk web
let currentQR = null;
let botStatus = "starting";

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
        h1{color:#2e7d32}.box{background:white;border-radius:16px;padding:30px;max-width:400px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.1)}</style>
      </head><body><div class="box">
        <div style="font-size:60px">✅</div>
        <h1>Bot Aktif!</h1>
        <p style="color:#555">Andri Logistik Bot sudah terhubung ke WhatsApp dan siap melayani pelanggan 24/7 🚢</p>
        <p style="color:#888;font-size:13px">Refresh halaman ini untuk cek status</p>
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
          h2{color:#e65100}.box{background:white;border-radius:16px;padding:24px;max-width:380px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.15)}
          img{border-radius:12px;border:3px solid #ff6b35}
          .warn{background:#fff3e0;border-radius:8px;padding:10px;margin-top:16px;color:#e65100;font-size:13px}</style>
        </head><body><div class="box">
          <div style="font-size:40px">📱</div>
          <h2>Scan QR Code ini!</h2>
          <img src="${qrImage}" width="260" height="260" />
          <div class="warn">⚠️ QR berlaku 60 detik<br>Halaman auto-refresh tiap 30 detik</div>
          <p style="color:#888;font-size:12px;margin-top:12px">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Scan</p>
        </div></body></html>`);
      } catch(e) {
        res.writeHead(500);
        res.end("Error generating QR");
      }
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
        <p style="color:#555">Halaman akan auto-refresh tiap 5 detik.<br>Tunggu sebentar ya!</p>
      </div></body></html>`);
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Web server aktif di port ${PORT}`);
  console.log(`🔗 Buka URL Railway kamu di browser untuk scan QR!`);
});

// =============================================
// DATABASE LOKAL
// =============================================
const DB_PATH = "./data";
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

function loadDB(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(file));
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
  const customKnowledge = Object.entries(customQA)
    .map(([q, a]) => `Q: ${q}\nA: ${a}`).join("\n\n");
  return `Kamu adalah "Andra" — asisten virtual WhatsApp untuk "Andri Logistik", jasa pengiriman paket Surabaya ke Maluku Utara.

=== INFORMASI BISNIS ===
- Rute: Surabaya → Ternate, Tidore, Sofifi, Tobelo, Sanana, Bacan, Morotai, seluruh Maluku Utara
- Estimasi: 5–10 hari kerja
- Tarif: mulai Rp 25.000/kg (volumetrik: PxLxT÷5000)
- Minimal: 1 kg
- Jadwal: Senin & Kamis
- Jam: Senin–Sabtu 08.00–20.00 WIB
- Admin: 0812-3456-7890
- Agen Surabaya: Jl. Perak Barat No. 45 (dekat Pelabuhan Tanjung Perak)
- Bayar: BCA, BNI, Mandiri, GoPay, OVO, Dana, QRIS
- Extra: packing kayu +Rp 30.000, bubble wrap +Rp 10.000, asuransi tersedia

=== PENGETAHUAN CUSTOM ===
${customKnowledge || "Belum ada."}

=== BAHASA ===
Deteksi bahasa pelanggan dan balas dengan bahasa SAMA:
- Ternate: ngana(kamu), torang(kita), seng(tidak), dang(sudah), pi(pergi)
- Tidore: ngoni(kalian), gita(kita), nyawa(kamu)
- Makassar: ki(sopan), iye(iya), tena(tidak), eroka(mau), sikamma(semua)
- Manado: ngana(kamu), torang(kita), so(sudah), nda(tidak), kang(kan)
- Ambon: ale(kamu), beta(saya), su(sudah), tra(tidak), katong(kita), pung(punya)

=== ATURAN ===
- Ramah & hangat seperti teman
- Jawaban singkat, max 5 kalimat
- Emoji natural
- Jangan pakai *tebal* atau _miring_
- Ingat konteks percakapan`;
}

// =============================================
// VOLUMETRIK
// =============================================
function parseVolumetrik(text) {
  const match = text.match(/(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)/i);
  if (match) return { p: +match[1], l: +match[2], t: +match[3] };
  return null;
}

// =============================================
// DATABASE CUSTOMER
// =============================================
function saveCustomer(phone) {
  if (!customerData[phone]) {
    customerData[phone] = { phone, firstContact: new Date().toISOString(), totalChats: 0, lastChat: null };
  }
  customerData[phone].totalChats += 1;
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
  chatHistory[phone].push({ role: "user", parts: [{ text: pesan }] });
  chatHistory[phone].push({ role: "model", parts: [{ text: balasan }] });
  if (chatHistory[phone].length > 30) chatHistory[phone].splice(0, 2);
  return balasan;
}

// =============================================
// RINGKASAN OTOMATIS
// =============================================
async function buatRingkasan(phone) {
  const hist = chatHistory[phone] || [];
  if (hist.length < 4) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const histText = hist.map(h => `${h.role === "user" ? "Pelanggan" : "Bot"}: ${h.parts[0].text}`).join("\n");
    const result = await model.generateContent(`Buat ringkasan singkat 3 poin dari percakapan ini:\n${histText}\n\nFormat:\n• Kebutuhan: ...\n• Info diberikan: ...\n• Tindak lanjut: ...`);
    const summary = result.response.text();
    chatSummaries[phone] = { summary, time: new Date().toISOString() };
    saveDB("summaries", chatSummaries);
    return summary;
  } catch(e) { return null; }
}

// =============================================
// PANEL OWNER
// =============================================
const userState = {};
const liveAgentSessions = {};

function pesanHelp() {
  return `🤖 PANEL OWNER — Andri Logistik Bot v4

📚 TRAINING BOT:
latih | pertanyaan | jawaban
hapus | pertanyaan
lihat training

📦 PESANAN:
pesanan | noResi | nama | tujuan | status
update | noResi | status baru
lihat pesanan

📊 DATA:
statistik
data pelanggan
ringkasan | 628xxx

📣 BROADCAST:
broadcast | isi pesan

🔔 FOLLOW UP:
followup | 628xxx | pesan

❌ KELUAR:
keluar`;
}

async function handleOwner(sock, pengirim, text, ownerPhone) {
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
    const [, q, a] = text.split("|").map(s => s.trim());
    if (q && a) {
      customQA[q.toLowerCase()] = a;
      saveDB("custom_qa", customQA);
      await sock.sendMessage(pengirim, { text: `✅ Bot dilatih!\nPertanyaan: ${q}\nJawaban: ${a}` });
    } else {
      await sock.sendMessage(pengirim, { text: "⚠️ Format: latih | pertanyaan | jawaban" });
    }
    return true;
  }

  if (text.startsWith("hapus |")) {
    const q = text.split("|")[1]?.trim().toLowerCase();
    if (q && customQA[q]) { delete customQA[q]; saveDB("custom_qa", customQA); await sock.sendMessage(pengirim, { text: `✅ Dihapus: ${q}` }); }
    else await sock.sendMessage(pengirim, { text: `❌ Tidak ditemukan: ${q}` });
    return true;
  }

  if (text === "lihat training") {
    const list = Object.entries(customQA);
    await sock.sendMessage(pengirim, { text: list.length ? "📚 Training:\n\n" + list.map(([q,a],i) => `${i+1}. ❓${q}\n   💬${a}`).join("\n\n") : "📚 Belum ada training." });
    return true;
  }

  if (text === "statistik") {
    await sock.sendMessage(pengirim, { text: `📊 Statistik:\n\n👥 Pelanggan: ${Object.keys(customerData).length}\n📦 Pesanan: ${Object.keys(orderTracking).length}\n📚 Training: ${Object.keys(customQA).length}\n🕐 ${new Date().toLocaleString("id-ID",{timeZone:"Asia/Jakarta"})}` });
    return true;
  }

  if (text === "data pelanggan") {
    const list = Object.values(customerData).slice(-10);
    await sock.sendMessage(pengirim, { text: list.length ? "👥 Pelanggan terakhir:\n\n" + list.map((c,i) => `${i+1}. ${c.phone}\n   Chat: ${c.totalChats}x\n   Terakhir: ${new Date(c.lastChat).toLocaleDateString("id-ID")}`).join("\n\n") : "👥 Belum ada data." });
    return true;
  }

  if (text.startsWith("pesanan |")) {
    const [,no,nama,tujuan,status] = text.split("|").map(s=>s.trim());
    if (no&&nama&&tujuan&&status) {
      orderTracking[no] = {no,nama,tujuan,status,updatedAt:new Date().toISOString()};
      saveDB("orders",orderTracking);
      await sock.sendMessage(pengirim, { text: `✅ Pesanan ditambah!\n📦 ${no}\n👤 ${nama}\n📍 ${tujuan}\n🔄 ${status}` });
    } else await sock.sendMessage(pengirim, { text: "⚠️ Format: pesanan | noResi | nama | tujuan | status" });
    return true;
  }

  if (text === "lihat pesanan") {
    const list = Object.values(orderTracking).slice(-10);
    await sock.sendMessage(pengirim, { text: list.length ? "📦 Pesanan:\n\n" + list.map((o,i) => `${i+1}. ${o.no}\n   👤${o.nama} → 📍${o.tujuan}\n   🔄${o.status}`).join("\n\n") : "📦 Belum ada pesanan." });
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
      try { await sock.sendMessage(`${ph}@s.whatsapp.net`,{text:`📢 Info Andri Logistik:\n\n${pesan}`}); ok++; await new Promise(r=>setTimeout(r,2000)); } catch(e){}
    }
    await sock.sendMessage(pengirim,{text:`✅ Selesai! ${ok}/${customers.length} terkirim.`});
    return true;
  }

  if (text.startsWith("followup |")) {
    const [,phone,pesan] = text.split("|").map(s=>s.trim());
    const target = phone?.replace(/\D/g,"");
    try { await sock.sendMessage(`${target}@s.whatsapp.net`,{text:`🚢 Andri Logistik\n\n${pesan}\n\nInfo: 0812-3456-7890`}); await sock.sendMessage(pengirim,{text:`✅ Follow up terkirim ke ${target}`}); }
    catch(e) { await sock.sendMessage(pengirim,{text:`❌ Gagal kirim ke ${target}`}); }
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
async function handleCustomer(sock, pengirim, isiPesan, ownerPhone) {
  saveCustomer(pengirim);

  // Live agent aktif
  if (liveAgentSessions[pengirim]) {
    if (["selesai","keluar","exit"].includes(isiPesan.toLowerCase())) {
      delete liveAgentSessions[pengirim];
      await sock.sendMessage(pengirim,{text:"✅ Sesi dengan admin selesai. Terima kasih! 😊🚢"});
      if (ownerPhone) await sock.sendMessage(ownerPhone,{text:`ℹ️ Pelanggan ${pengirim} mengakhiri live agent.`});
    } else {
      if (ownerPhone) await sock.sendMessage(ownerPhone,{text:`💬 Pesan dari ${pengirim}:\n\n${isiPesan}`});
      await sock.sendMessage(pengirim,{text:"📨 Pesan diteruskan ke admin. Mohon tunggu! 😊"});
    }
    return;
  }

  // Minta live agent
  if (["live agent","hubungi admin","minta cs","bicara admin","hubungi cs"].some(k=>isiPesan.toLowerCase().includes(k))) {
    liveAgentSessions[pengirim] = true;
    await sock.sendMessage(pengirim,{text:"🙋 Oke! Menghubungkan ke admin Andri Logistik...\n\nMohon tunggu ya! 😊\n\n(Ketik 'selesai' untuk kembali ke bot)"});
    if (ownerPhone) await sock.sendMessage(ownerPhone,{text:`🔔 LIVE AGENT REQUEST!\nDari: ${pengirim}\nPesan: ${isiPesan}\n\nBalas langsung ke nomor pelanggan!`});
    return;
  }

  // Hitung volumetrik
  const vol = parseVolumetrik(isiPesan);
  if (vol && isiPesan.match(/volum|ukuran|dimensi|panjang|lebar|tinggi|cm/i)) {
    const beratVol = Math.round((vol.p*vol.l*vol.t)/5000*10)/10;
    const beratMatch = isiPesan.match(/(\d+(?:\.\d+)?)\s*kg/i);
    const beratAktual = beratMatch ? parseFloat(beratMatch[1]) : 0;
    const beratFinal = Math.max(beratVol, beratAktual);
    await sock.sendMessage(pengirim,{text:`📦 Hasil Hitung Volumetrik:\n\n📐 Ukuran: ${vol.p}×${vol.l}×${vol.t} cm\n⚖️ Berat volumetrik: ${beratVol} kg\n${beratAktual?`⚖️ Berat aktual: ${beratAktual} kg\n`:""}✅ Berat digunakan: ${beratFinal} kg\n💰 Estimasi ongkir: Rp ${(Math.ceil(beratFinal)*25000).toLocaleString("id-ID")}\n\nUntuk tarif pasti hubungi admin: 0812-3456-7890 😊🚢`});
    return;
  }

  // Cek tracking
  const resiMatch = isiPesan.match(/\b(AL|ORD)[- ]?(\w+)\b/i);
  if (resiMatch) {
    const no = resiMatch[0].toUpperCase();
    const order = orderTracking[no];
    if (order) {
      await sock.sendMessage(pengirim,{text:`📦 Status ${no}:\n\n👤 ${order.nama}\n📍 ${order.tujuan}\n🔄 ${order.status}\n🕐 ${new Date(order.updatedAt).toLocaleString("id-ID")}\n\nInfo: 0812-3456-7890 😊`});
      return;
    }
  }

  // Jawab dengan AI
  const balasan = await tanyaGemini(pengirim, isiPesan);
  await sock.sendMessage(pengirim,{text:balasan});

  // Auto ringkasan setiap 20 pesan
  const hist = chatHistory[pengirim]||[];
  if (hist.length>0 && hist.length%20===0) {
    const summary = await buatRingkasan(pengirim);
    if (summary && ownerPhone) await sock.sendMessage(ownerPhone,{text:`📝 Auto Ringkasan\nPelanggan: ${pengirim}\n\n${summary}`});
  }

  // Notif pelanggan baru
  const cust = customerData[pengirim];
  if (cust?.totalChats===1 && ownerPhone) {
    await sock.sendMessage(ownerPhone,{text:`🆕 Pelanggan Baru!\nNomor: ${pengirim}\nPesan: ${isiPesan}`});
  }
}

// =============================================
// JALANKAN BOT
// =============================================
async function jalankanBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
      botStatus = "waiting_scan";
      console.log("📱 QR Code siap! Buka URL Railway kamu di browser untuk scan!");
    }
    if (connection === "close") {
      currentQR = null;
      botStatus = "reconnecting";
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) { console.log("🔄 Reconnecting..."); setTimeout(jalankanBot, 3000); }
      else { botStatus = "logged_out"; console.log("🚪 Bot logout."); }
    }
    if (connection === "open") {
      currentQR = null;
      botStatus = "connected";
      console.log("✅ Andri Logistik Bot AKTIF! Siap melayani 24/7 🚢");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) return;
      const pengirim = msg.key.remoteJid;
      if (pengirim.endsWith("@g.us")) return;
      const isiPesan = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
      if (!isiPesan.trim()) return;
      const ownerPhone = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
      const isOwner = ownerPhone && pengirim === ownerPhone;
      console.log(`📩 [${new Date().toLocaleTimeString("id-ID")}] ${isOwner?"👑 OWNER":"👤"} ${pengirim}: ${isiPesan}`);
      try {
        await sock.readMessages([msg.key]);
        await sock.sendPresenceUpdate("composing", pengirim);
        if (isOwner || userState[pengirim]?.mode === "owner") {
          const handled = await handleOwner(sock, pengirim, isiPesan.trim(), ownerPhone);
          if (handled) { await sock.sendPresenceUpdate("paused", pengirim); continue; }
        }
        await handleCustomer(sock, pengirim, isiPesan, ownerPhone);
        await sock.sendPresenceUpdate("paused", pengirim);
      } catch(err) {
        console.error("❌ Error:", err.message);
        await sock.sendPresenceUpdate("paused", pengirim);
        await sock.sendMessage(pengirim,{text:"Maaf ada gangguan 🙏 Hubungi admin: 0812-3456-7890"});
      }
    }
  });
}

console.log("🚀 Memulai Andri Logistik Bot v4...");
jalankanBot();
