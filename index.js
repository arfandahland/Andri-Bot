// ============================================================
// ANDRI LOGISTIK BOT v4 — SUPER CANGGIH
// Fitur: Multibahasa, Training Mode, Volumetrik, Live Agent,
//        Auto Summary, Follow Up, Broadcast, dan 20+ fitur
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// =============================================
// KONFIGURASI UTAMA
// =============================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OWNER_NUMBER = process.env.OWNER_NUMBER || ""; // nomor WA pemilik: 628xxxxxxxxxx
const OWNER_PASSWORD = "BOTPINTAR"; // sandi rahasia pemilik
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// =============================================
// DATABASE LOKAL (file JSON)
// =============================================
const DB_PATH = "./data";
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

function loadDB(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(file));
}

function saveDB(name, data) {
  const file = path.join(DB_PATH, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Database
let customQA = loadDB("custom_qa");         // pertanyaan-jawaban custom dari pemilik
let customerData = loadDB("customers");      // data pelanggan
let orderTracking = loadDB("orders");        // tracking pesanan
let chatSummaries = loadDB("summaries");     // ringkasan percakapan
let broadcastList = loadDB("broadcast");     // daftar broadcast
let followUpList = loadDB("followup");       // daftar follow up

// =============================================
// STATE IN-MEMORY
// =============================================
const chatHistory = {};         // histori percakapan per nomor
const userState = {};           // state user (mode training, live agent, dll)
const liveAgentSessions = {};   // sesi live agent aktif
const typingTimers = {};        // timer anti-spam

// =============================================
// SISTEM PROMPT UTAMA
// =============================================
function buildSystemPrompt() {
  const customKnowledge = Object.entries(customQA)
    .map(([q, a]) => `Q: ${q}\nA: ${a}`)
    .join("\n\n");

  return `Kamu adalah "Andra" — asisten virtual WhatsApp super canggih untuk "Andri Logistik".

=== INFORMASI BISNIS ===
- Nama usaha: Andri Logistik
- Layanan: Jasa titip & pengiriman paket Surabaya → Maluku Utara
- Rute: Ternate, Tidore, Sofifi, Tobelo, Sanana, Bacan, Morotai, dan seluruh Maluku Utara
- Estimasi: 5–10 hari kerja
- Tarif: mulai Rp 25.000/kg
- Tarif volumetrik: (P×L×T)÷5000 kg
- Minimal: 1 kg
- Jadwal: Senin & Kamis
- Jam: Senin–Sabtu 08.00–20.00 WIB
- Admin: 0812-3456-7890
- Agen Surabaya: Jl. Perak Barat No. 45 (dekat Pelabuhan Tanjung Perak)
- Bayar: BCA, BNI, Mandiri, GoPay, OVO, Dana, QRIS
- Tambahan: packing kayu +Rp 30.000, bubble wrap +Rp 10.000, asuransi tersedia

=== CARA HITUNG VOLUMETRIK ===
Rumus: (Panjang cm × Lebar cm × Tinggi cm) ÷ 5000 = berat volumetrik (kg)
Gunakan berat terbesar antara berat aktual vs volumetrik.
Contoh: kotak 50×40×30 cm → (50×40×30)÷5000 = 12 kg volumetrik

=== CARA ORDER ===
1. Chat admin 0812-3456-7890
2. Info barang, berat, tujuan
3. Konfirmasi tarif & jadwal
4. Antar ke agen Surabaya
5. Bayar → barang dikirim → notif tracking

=== PENGETAHUAN CUSTOM (dilatih oleh pemilik) ===
${customKnowledge || "Belum ada pengetahuan custom."}

=== KEMAMPUAN BAHASA ===
Deteksi bahasa pelanggan dan balas dengan bahasa yang SAMA:
- Indonesia: bahasa standar
- Ternate: "ngana"(kamu), "torang"(kita), "seng"(tidak), "dang"(sudah), "pi"(pergi)
- Tidore: "ngoni"(kalian), "gita"(kita), "nyawa"(kamu)
- Makassar: "ki"(sopan), "iye"(iya), "tena"(tidak ada), "eroka"(mau), "sikamma"(semua)
- Manado: "ngana"(kamu), "torang"(kita), "so"(sudah), "nda"(tidak), "kang"(kan)
- Ambon: "ale"(kamu), "beta"(saya), "dong"(mereka), "su"(sudah), "tra"(tidak), "katong"(kita)

=== ATURAN MENJAWAB ===
- Ramah dan hangat seperti teman
- Jawaban padat, maksimal 5 kalimat
- Emoji natural sesuai konteks
- Jangan pakai *tebal* atau _miring_ (ini WhatsApp biasa)
- Jika komplain → empati, minta maaf, tawarkan solusi
- Ingat konteks percakapan sebelumnya`;
}

// =============================================
// HITUNG VOLUMETRIK
// =============================================
function hitungVolumetrik(p, l, t) {
  const beratVol = (p * l * t) / 5000;
  return Math.round(beratVol * 10) / 10;
}

function parseVolumetrik(text) {
  // Deteksi format: 50x40x30 atau 50×40×30 atau p:50 l:40 t:30
  const match = text.match(/(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)/i);
  if (match) {
    return {
      p: parseFloat(match[1]),
      l: parseFloat(match[2]),
      t: parseFloat(match[3]),
    };
  }
  return null;
}

// =============================================
// SIMPAN DATA PELANGGAN
// =============================================
function saveCustomer(phone, info) {
  if (!customerData[phone]) {
    customerData[phone] = {
      phone,
      firstContact: new Date().toISOString(),
      totalChats: 0,
      lastChat: null,
      info: {},
    };
  }
  customerData[phone].totalChats += 1;
  customerData[phone].lastChat = new Date().toISOString();
  if (info) Object.assign(customerData[phone].info, info);
  saveDB("customers", customerData);
}

// =============================================
// RINGKASAN PERCAKAPAN
// =============================================
async function buatRingkasan(phone, history) {
  if (history.length < 4) return null;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const historyText = history
      .map(h => `${h.role === "user" ? "Pelanggan" : "Bot"}: ${h.parts[0].text}`)
      .join("\n");
    const result = await model.generateContent(
      `Buat ringkasan singkat percakapan WhatsApp berikut dalam 3 poin penting (bahasa Indonesia, singkat):
${historyText}

Format:
• Kebutuhan: ...
• Info yang diberikan: ...
• Tindak lanjut: ...`
    );
    const summary = result.response.text();
    chatSummaries[phone] = {
      summary,
      time: new Date().toISOString(),
      messageCount: history.length,
    };
    saveDB("summaries", chatSummaries);
    return summary;
  } catch (e) {
    return null;
  }
}

// =============================================
// TANYA GEMINI AI
// =============================================
async function tanyaGemini(phone, pesanUser) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: buildSystemPrompt(),
    generationConfig: { maxOutputTokens: 600, temperature: 0.85, topP: 0.9 },
  });

  if (!chatHistory[phone]) chatHistory[phone] = [];
  const history = chatHistory[phone];

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(pesanUser);
  const balasan = result.response.text();

  history.push({ role: "user", parts: [{ text: pesanUser }] });
  history.push({ role: "model", parts: [{ text: balasan }] });
  if (history.length > 40) history.splice(0, 2);

  return balasan;
}

// =============================================
// FORMAT PESAN BANTUAN OWNER
// =============================================
function pesanBantuanOwner() {
  return `🤖 *PANEL OWNER — Andri Logistik Bot*

📚 *MODE TRAINING:*
Ketik: BOTPINTAR
Lalu: latih | pertanyaan | jawaban

🗑 *Hapus training:*
hapus | pertanyaan

📋 *Lihat semua training:*
lihat training

📊 *Statistik:*
statistik

👥 *Data pelanggan:*
data pelanggan

📦 *Tambah pesanan:*
pesanan | nomor | nama | tujuan | status

✅ *Update status pesanan:*
update | nomor | status baru

📣 *Broadcast pesan:*
broadcast | isi pesan

🔔 *Follow up pelanggan:*
followup | nomor | pesan

📝 *Ringkasan chat pelanggan:*
ringkasan | nomor

❌ *Keluar mode owner:*
keluar`;
}

// =============================================
// HANDLE PERINTAH OWNER
// =============================================
async function handleOwnerCommand(sock, pengirim, pesan, ownerPhone) {
  const text = pesan.trim();

  // MASUK MODE TRAINING
  if (text === OWNER_PASSWORD) {
    userState[pengirim] = { mode: "owner" };
    await sock.sendMessage(pengirim, { text: pesanBantuanOwner() });
    return true;
  }

  if (userState[pengirim]?.mode !== "owner") return false;

  // KELUAR
  if (text === "keluar") {
    delete userState[pengirim];
    await sock.sendMessage(pengirim, { text: "✅ Keluar dari mode Owner. Bot kembali normal!" });
    return true;
  }

  // TAMBAH TRAINING: latih | pertanyaan | jawaban
  if (text.startsWith("latih |")) {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length >= 3) {
      const pertanyaan = parts[1].toLowerCase();
      const jawaban = parts[2];
      customQA[pertanyaan] = jawaban;
      saveDB("custom_qa", customQA);
      await sock.sendMessage(pengirim, {
        text: `✅ Bot berhasil dilatih!\n\n❓ Pertanyaan: ${pertanyaan}\n💬 Jawaban: ${jawaban}`,
      });
    } else {
      await sock.sendMessage(pengirim, { text: "⚠️ Format salah!\nGunakan: latih | pertanyaan | jawaban" });
    }
    return true;
  }

  // HAPUS TRAINING
  if (text.startsWith("hapus |")) {
    const pertanyaan = text.split("|")[1]?.trim().toLowerCase();
    if (pertanyaan && customQA[pertanyaan]) {
      delete customQA[pertanyaan];
      saveDB("custom_qa", customQA);
      await sock.sendMessage(pengirim, { text: `✅ Training "${pertanyaan}" berhasil dihapus!` });
    } else {
      await sock.sendMessage(pengirim, { text: `❌ Pertanyaan "${pertanyaan}" tidak ditemukan.` });
    }
    return true;
  }

  // LIHAT SEMUA TRAINING
  if (text === "lihat training") {
    const list = Object.entries(customQA);
    if (list.length === 0) {
      await sock.sendMessage(pengirim, { text: "📚 Belum ada training custom." });
    } else {
      const msg = "📚 *Daftar Training Bot:*\n\n" +
        list.map(([q, a], i) => `${i + 1}. ❓ ${q}\n   💬 ${a}`).join("\n\n");
      await sock.sendMessage(pengirim, { text: msg });
    }
    return true;
  }

  // STATISTIK
  if (text === "statistik") {
    const totalCustomer = Object.keys(customerData).length;
    const totalOrder = Object.keys(orderTracking).length;
    const totalTraining = Object.keys(customQA).length;
    const totalSummary = Object.keys(chatSummaries).length;
    await sock.sendMessage(pengirim, {
      text: `📊 *Statistik Andri Logistik Bot*\n\n` +
        `👥 Total pelanggan: ${totalCustomer}\n` +
        `📦 Total pesanan: ${totalOrder}\n` +
        `📚 Training custom: ${totalTraining}\n` +
        `📝 Ringkasan chat: ${totalSummary}\n` +
        `🕐 Update: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`,
    });
    return true;
  }

  // DATA PELANGGAN
  if (text === "data pelanggan") {
    const list = Object.values(customerData);
    if (list.length === 0) {
      await sock.sendMessage(pengirim, { text: "👥 Belum ada data pelanggan." });
    } else {
      const msg = "👥 *Data Pelanggan:*\n\n" +
        list.slice(-10).map((c, i) =>
          `${i + 1}. 📱 ${c.phone}\n   💬 Total chat: ${c.totalChats}\n   🕐 Terakhir: ${new Date(c.lastChat).toLocaleDateString("id-ID")}`
        ).join("\n\n") +
        (list.length > 10 ? `\n\n...dan ${list.length - 10} pelanggan lainnya` : "");
      await sock.sendMessage(pengirim, { text: msg });
    }
    return true;
  }

  // TAMBAH PESANAN: pesanan | nomornoresi | nama | tujuan | status
  if (text.startsWith("pesanan |")) {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length >= 5) {
      const [, noResi, nama, tujuan, status] = parts;
      orderTracking[noResi] = { noResi, nama, tujuan, status, updatedAt: new Date().toISOString() };
      saveDB("orders", orderTracking);
      await sock.sendMessage(pengirim, {
        text: `✅ Pesanan berhasil ditambahkan!\n\n📦 No Resi: ${noResi}\n👤 Nama: ${nama}\n📍 Tujuan: ${tujuan}\n🔄 Status: ${status}`,
      });
    } else {
      await sock.sendMessage(pengirim, { text: "⚠️ Format: pesanan | noResi | nama | tujuan | status" });
    }
    return true;
  }

  // UPDATE STATUS PESANAN: update | nomorresi | status baru
  if (text.startsWith("update |")) {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length >= 3) {
      const [, noResi, statusBaru] = parts;
      if (orderTracking[noResi]) {
        orderTracking[noResi].status = statusBaru;
        orderTracking[noResi].updatedAt = new Date().toISOString();
        saveDB("orders", orderTracking);
        await sock.sendMessage(pengirim, { text: `✅ Status pesanan ${noResi} diupdate: ${statusBaru}` });
      } else {
        await sock.sendMessage(pengirim, { text: `❌ No resi ${noResi} tidak ditemukan.` });
      }
    }
    return true;
  }

  // BROADCAST: broadcast | isi pesan
  if (text.startsWith("broadcast |")) {
    const pesan = text.split("|")[1]?.trim();
    if (!pesan) {
      await sock.sendMessage(pengirim, { text: "⚠️ Format: broadcast | isi pesan" });
      return true;
    }
    const customers = Object.keys(customerData);
    if (customers.length === 0) {
      await sock.sendMessage(pengirim, { text: "⚠️ Belum ada data pelanggan untuk broadcast." });
      return true;
    }
    await sock.sendMessage(pengirim, { text: `📣 Memulai broadcast ke ${customers.length} pelanggan...` });
    let sukses = 0;
    for (const phone of customers) {
      try {
        await sock.sendMessage(`${phone}@s.whatsapp.net`, {
          text: `📢 *Info dari Andri Logistik:*\n\n${pesan}`,
        });
        sukses++;
        await new Promise(r => setTimeout(r, 2000)); // delay 2 detik antar pesan
      } catch (e) {
        console.error(`Gagal broadcast ke ${phone}`);
      }
    }
    await sock.sendMessage(pengirim, { text: `✅ Broadcast selesai! Terkirim ke ${sukses}/${customers.length} pelanggan.` });
    return true;
  }

  // FOLLOW UP: followup | nomor | pesan
  if (text.startsWith("followup |")) {
    const parts = text.split("|").map(s => s.trim());
    if (parts.length >= 3) {
      const [, phone, pesanFU] = parts;
      const target = phone.replace(/\D/g, "");
      try {
        await sock.sendMessage(`${target}@s.whatsapp.net`, {
          text: `🚢 *Andri Logistik*\n\n${pesanFU}\n\nInfo lebih lanjut hubungi: 0812-3456-7890`,
        });
        await sock.sendMessage(pengirim, { text: `✅ Follow up berhasil dikirim ke ${target}!` });
      } catch (e) {
        await sock.sendMessage(pengirim, { text: `❌ Gagal kirim ke ${target}. Cek nomor & format.` });
      }
    } else {
      await sock.sendMessage(pengirim, { text: "⚠️ Format: followup | 628xxx | isi pesan" });
    }
    return true;
  }

  // RINGKASAN CHAT PELANGGAN
  if (text.startsWith("ringkasan |")) {
    const phone = text.split("|")[1]?.trim().replace(/\D/g, "");
    const summary = chatSummaries[`${phone}@s.whatsapp.net`];
    if (summary) {
      await sock.sendMessage(pengirim, {
        text: `📝 *Ringkasan Chat ${phone}:*\n\n${summary.summary}\n\n🕐 ${new Date(summary.time).toLocaleString("id-ID")} (${summary.messageCount} pesan)`,
      });
    } else {
      await sock.sendMessage(pengirim, { text: `❌ Belum ada ringkasan untuk nomor ${phone}.` });
    }
    return true;
  }

  return false;
}

// =============================================
// HANDLE PESAN MASUK CUSTOMER
// =============================================
async function handleCustomerMessage(sock, pengirim, isiPesan, ownerPhone) {

  // Simpan data pelanggan
  saveCustomer(pengirim, null);

  // CEK LIVE AGENT — jika aktif, teruskan ke owner
  if (liveAgentSessions[pengirim]) {
    if (isiPesan.toLowerCase() === "selesai" || isiPesan.toLowerCase() === "keluar") {
      delete liveAgentSessions[pengirim];
      await sock.sendMessage(pengirim, { text: "✅ Sesi live agent selesai. Terima kasih! Bila ada pertanyaan lain, kami siap membantu 😊🚢" });
      if (ownerPhone) await sock.sendMessage(ownerPhone, { text: `ℹ️ Pelanggan ${pengirim} mengakhiri sesi live agent.` });
      return;
    }
    // Teruskan ke owner
    if (ownerPhone) {
      await sock.sendMessage(ownerPhone, {
        text: `💬 *Pesan dari pelanggan ${pengirim}:*\n\n${isiPesan}`,
      });
    }
    await sock.sendMessage(pengirim, { text: "📨 Pesan kamu sudah diteruskan ke admin. Mohon tunggu balasan ya! 😊" });
    return;
  }

  // CEK PERMINTAAN LIVE AGENT
  const mintaAgent = ["live agent", "hubungi admin", "minta cs", "bicara admin", "hubungi cs", "minta admin"].some(k => isiPesan.toLowerCase().includes(k));
  if (mintaAgent) {
    liveAgentSessions[pengirim] = { startTime: new Date().toISOString() };
    await sock.sendMessage(pengirim, {
      text: "🙋 Oke! Saya hubungkan kamu dengan admin Andri Logistik sekarang.\n\nMohon tunggu sebentar ya... Admin akan segera membalas! 😊\n\n(Ketik 'selesai' untuk kembali ke bot)",
    });
    if (ownerPhone) {
      await sock.sendMessage(ownerPhone, {
        text: `🔔 *Permintaan Live Agent!*\n\nPelanggan: ${pengirim}\nPesan: ${isiPesan}\n\nBalas langsung ke nomor pelanggan di atas ya!`,
      });
    }
    return;
  }

  // CEK VOLUMETRIK
  const volData = parseVolumetrik(isiPesan);
  const beratMatch = isiPesan.match(/(\d+(?:\.\d+)?)\s*kg/i);
  if (volData && isiPesan.toLowerCase().includes("volume") || (volData && isiPesan.toLowerCase().match(/volum|ukuran|dimensi|panjang|lebar|tinggi/))) {
    const vol = hitungVolumetrik(volData.p, volData.l, volData.t);
    const beratAktual = beratMatch ? parseFloat(beratMatch[1]) : 0;
    const beratFinal = Math.max(vol, beratAktual);
    const estimasiHarga = Math.ceil(beratFinal) * 25000;
    await sock.sendMessage(pengirim, {
      text: `📦 Hasil Hitung Volumetrik:\n\n` +
        `📐 Ukuran: ${volData.p}×${volData.l}×${volData.t} cm\n` +
        `⚖️ Berat volumetrik: ${vol} kg\n` +
        (beratAktual ? `⚖️ Berat aktual: ${beratAktual} kg\n` : "") +
        `✅ Berat yang digunakan: ${beratFinal} kg\n` +
        `💰 Estimasi ongkir: Rp ${estimasiHarga.toLocaleString("id-ID")}\n\n` +
        `Untuk tarif pasti ke tujuan kamu, hubungi admin di 0812-3456-7890 ya! 😊🚢`,
    });
    return;
  }

  // CEK TRACKING PESANAN
  const noResiMatch = isiPesan.match(/\b(AL|ORD|ANDRI)[- ]?(\d{4,})\b/i);
  if (noResiMatch || isiPesan.toLowerCase().includes("cek pesanan") || isiPesan.toLowerCase().includes("status paket")) {
    if (noResiMatch) {
      const noResi = noResiMatch[0].toUpperCase().replace(/\s/g, "");
      const order = orderTracking[noResi];
      if (order) {
        await sock.sendMessage(pengirim, {
          text: `📦 Status Pesanan ${noResi}:\n\n` +
            `👤 Nama: ${order.nama}\n` +
            `📍 Tujuan: ${order.tujuan}\n` +
            `🔄 Status: ${order.status}\n` +
            `🕐 Update: ${new Date(order.updatedAt).toLocaleString("id-ID")}\n\n` +
            `Info lebih lanjut hubungi admin: 0812-3456-7890 😊`,
        });
        return;
      }
    }
  }

  // JAWAB DENGAN GEMINI AI
  const balasan = await tanyaGemini(pengirim, isiPesan);
  await sock.sendMessage(pengirim, { text: balasan });

  // AUTO RINGKASAN setiap 20 pesan
  const hist = chatHistory[pengirim] || [];
  if (hist.length > 0 && hist.length % 20 === 0) {
    const summary = await buatRingkasan(pengirim, hist);
    if (summary && ownerPhone) {
      await sock.sendMessage(ownerPhone, {
        text: `📝 *Auto Ringkasan Chat*\nPelanggan: ${pengirim}\n\n${summary}`,
      });
    }
  }

  // NOTIF KE OWNER jika pelanggan baru
  const customer = customerData[pengirim];
  if (customer && customer.totalChats === 1 && ownerPhone) {
    await sock.sendMessage(ownerPhone, {
      text: `🆕 *Pelanggan Baru!*\nNomor: ${pengirim}\nPesan pertama: ${isiPesan}`,
    });
  }
}

// =============================================
// FUNGSI UTAMA: Jalankan Bot
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
      console.log("\n╔══════════════════════════════════════════╗");
      console.log("║  📱 SCAN QR CODE INI DENGAN WHATSAPP    ║");
      console.log("╚══════════════════════════════════════════╝\n");
      qrcode.generate(qr, { small: true });
      console.log("\n╔══════════════════════════════════════════╗");
      console.log("║  ⚠️  QR berlaku 60 detik — scan segera  ║");
      console.log("╚══════════════════════════════════════════╝\n");
    }

    if (connection === "close") {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        setTimeout(jalankanBot, 3000);
      } else {
        console.log("🚪 Bot logout. Hapus folder auth_info dan jalankan ulang.");
      }
    }

    if (connection === "open") {
      console.log("\n╔══════════════════════════════════════════════╗");
      console.log("║  ✅ ANDRI LOGISTIK BOT v4 AKTIF!            ║");
      console.log("║  🚢 Siap melayani pelanggan 24/7             ║");
      console.log("║  🌏 6 Bahasa: ID/Ternate/Tidore/MKS/MND/AMB ║");
      console.log("║  🧠 AI Pintar + Training + Live Agent        ║");
      console.log("╚══════════════════════════════════════════════╝\n");
    }
  });

  // HANDLE PESAN
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) return;

      const pengirim = msg.key.remoteJid;
      if (pengirim.endsWith("@g.us")) return;

      const isiPesan =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || "";

      if (!isiPesan.trim()) {
        if (msg.message?.imageMessage || msg.message?.documentMessage) {
          await sock.sendMessage(pengirim, {
            text: "Halo! 😊 Terima kasih sudah menghubungi Andri Logistik. Silakan ketik pertanyaan kamu ya! 🚢",
          });
        }
        return;
      }

      const ownerPhone = OWNER_NUMBER ? `${OWNER_NUMBER}@s.whatsapp.net` : null;
      const isOwner = ownerPhone && pengirim === ownerPhone;

      console.log(`📩 [${new Date().toLocaleTimeString("id-ID")}] ${isOwner ? "👑 OWNER" : "👤"} ${pengirim}: ${isiPesan}`);

      try {
        await sock.readMessages([msg.key]);
        await sock.sendPresenceUpdate("composing", pengirim);

        // Cek apakah owner
        if (isOwner || userState[pengirim]?.mode === "owner") {
          const handled = await handleOwnerCommand(sock, pengirim, isiPesan, ownerPhone);
          if (handled) {
            await sock.sendPresenceUpdate("paused", pengirim);
            continue;
          }
        }

        // Handle pelanggan biasa
        await handleCustomerMessage(sock, pengirim, isiPesan, ownerPhone);
        await sock.sendPresenceUpdate("paused", pengirim);

      } catch (err) {
        console.error("❌ Error:", err.message);
        await sock.sendPresenceUpdate("paused", pengirim);
        await sock.sendMessage(pengirim, {
          text: "Maaf ada gangguan teknis 🙏 Silakan hubungi admin kami di 0812-3456-7890 ya!",
        });
      }
    }
  });
}

console.log("🚀 Memulai Andri Logistik Bot v4...");
console.log("🧠 Fitur: AI + Training + Multibahasa + Live Agent + Tracking + Broadcast");
jalankanBot();
