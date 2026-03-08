const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================
// KONFIGURASI — isi sesuai milik kamu
// =============================================
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,   // dari console.anthropic.com
  FONNTE_TOKEN: process.env.FONNTE_TOKEN,              // dari app.fonnte.com
};

// =============================================
// SISTEM PROMPT ANDRI LOGISTIK
// =============================================
const SYSTEM_PROMPT = `Kamu adalah asisten virtual WhatsApp untuk "Andri Logistik" — jasa pengiriman paket dari Surabaya ke Maluku Utara.

Informasi bisnis:
- Nama: Andri Logistik
- Layanan: Jasa titip & pengiriman paket dari Surabaya ke Maluku Utara
- Rute: Surabaya → Maluku Utara (Ternate, Tidore, Sofifi, Tobelo, Sanana, dll)
- Estimasi pengiriman: 5–10 hari kerja tergantung tujuan
- Tarif: mulai Rp 25.000/kg (hubungi admin untuk tarif spesifik per kota)
- Minimal berat: 1 kg
- Jadwal keberangkatan: setiap Senin & Kamis
- Jam operasional: Senin–Sabtu 08.00–20.00 WIB
- Kontak admin: 0812-3456-7890 (WhatsApp)
- Cara order: Chat admin → konfirmasi barang → antar ke agen Surabaya → barang dikirim
- Agen Surabaya: Jl. Perak Barat No. 45, Surabaya (dekat pelabuhan)
- Pembayaran: Transfer BCA, BNI, GoPay, OVO, Dana
- Layanan tambahan: packing kayu untuk barang pecah belah (tambah Rp 30.000), asuransi pengiriman tersedia

Cara menjawab:
- Gunakan bahasa Indonesia yang ramah, santai tapi profesional
- Jawaban singkat dan padat, maksimal 5 kalimat
- Gunakan emoji secukupnya agar terkesan hangat
- Jika ditanya hal di luar logistik/pengiriman, alihkan kembali ke layanan kami
- Selalu tawarkan untuk menghubungi admin jika butuh info lebih detail
- Jangan gunakan format markdown seperti **tebal** — pakai teks biasa saja karena ini WhatsApp`;

// =============================================
// MEMORI PERCAKAPAN per nomor HP
// =============================================
const chatHistory = {}; // { "628xx": [ {role, content}, ... ] }

function getHistory(phone) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  return chatHistory[phone];
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Batasi histori maksimal 20 pesan agar tidak terlalu panjang
  if (history.length > 20) history.splice(0, 2);
}

// =============================================
// FUNGSI: Tanya ke Claude AI
// =============================================
async function tanyaClaude(phone, pesanUser) {
  addToHistory(phone, "user", pesanUser);

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: getHistory(phone),
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    }
  );

  const balasan = response.data.content[0].text;
  addToHistory(phone, "assistant", balasan);
  return balasan;
}

// =============================================
// FUNGSI: Kirim pesan balik via Fonnte
// =============================================
async function kirimPesan(nomorTujuan, pesan) {
  await axios.post(
    "https://api.fonnte.com/send",
    {
      target: nomorTujuan,
      message: pesan,
      countryCode: "62",
    },
    {
      headers: { Authorization: CONFIG.FONNTE_TOKEN },
    }
  );
}

// =============================================
// WEBHOOK — Fonnte akan kirim pesan masuk ke sini
// =============================================
app.post("/webhook", async (req, res) => {
  try {
    const { sender, message } = req.body;

    if (!sender || !message) {
      return res.status(400).json({ status: "data tidak lengkap" });
    }

    console.log(`📩 Pesan masuk dari ${sender}: ${message}`);

    // Balas dulu dengan status "mengetik" (opsional)
    // Tanya Claude
    const balasan = await tanyaClaude(sender, message);

    // Kirim balasan ke pelanggan
    await kirimPesan(sender, balasan);

    console.log(`✅ Balasan terkirim ke ${sender}: ${balasan}`);
    res.json({ status: "ok" });

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ status: "error", pesan: error.message });
  }
});

// =============================================
// HEALTH CHECK — untuk memastikan server hidup
// =============================================
app.get("/", (req, res) => {
  res.json({
    status: "🚢 Andri Logistik Bot aktif!",
    waktu: new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }),
  });
});

// =============================================
// JALANKAN SERVER
// =============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Andri Logistik Bot berjalan di port ${PORT}`);
});
