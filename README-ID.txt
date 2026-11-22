SMART SOLVER AI v3.1 — PAKET AWAL NETLIFY

ISI:
- index.html: kamera, baca langsung berkala, upload screenshot, OCR, pencarian bank soal online.
- netlify/functions/knowledge.js: API bank soal dengan Netlify Blobs.
- netlify.toml dan package.json.

CARA PASANG:
1. Buat repository GitHub baru bernama smart-solver-ai.
2. Upload SEMUA isi folder paket ini ke root repository (index.html harus terlihat di halaman utama repository).
3. Di Netlify pilih Add new site > Import an existing project > GitHub.
4. Pilih repository smart-solver-ai, build command kosong, publish directory: .
5. Sebelum deploy, buka Site configuration > Environment variables dan tambahkan:
   KNOWLEDGE_ADMIN_KEY = buat kata kunci admin panjang dan rahasia.
6. Deploy site. Tunggu selesai.
7. Buka alamat Netlify. Untuk tambah/edit/hapus soal buka menu Kelola Data dan masukkan kunci admin.

CATATAN PENTING:
- Netlify Blobs menyimpan bank soal online; perangkat yang membuka situs yang sama melihat bank yang sama.
- OCR memakai Tesseract.js dari CDN dan perlu internet. Kamera browser biasanya mensyaratkan HTTPS (Netlify menyediakan HTTPS).
- Tombol BACA LANGSUNG ada tetap di bagian paling bawah layar. Mode ini mengambil frame kamera berkala, bukan membaca setiap piksel secara kontinu; performa tergantung HP, cahaya, fokus, dan koneksi.
- Pencarian saat ini: exact match lebih dahulu, lalu kemiripan berbasis kata (bukan semantic AI). Indeks metadata memuat ID dan hash exact; pencarian fuzzy masih mengambil record untuk menghitung kemiripan. Untuk puluhan ribu record atau lebih, lakukan uji beban; jika mulai lambat, perlu indeks token terbalik atau layanan pencarian khusus.
- Netlify Blobs adalah penyimpanan sederhana, bukan database relasional. Paket ini cocok untuk prototipe dan uji awal. Buat ekspor cadangan berkala.
- Belum ada login akun admin individual, rate limit, audit log, atau perlindungan spam. Jangan bagikan kunci admin. Jangan buka akses tambah/hapus kepada publik.
- Fitur AI solver/Gemini belum disambungkan dalam paket ini. Paket ini fokus pada kamera/OCR dan bank soal. Integrasi AI bisa ditambahkan setelah alur bank soal diuji.
