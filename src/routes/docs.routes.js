import express from 'express';
import { catalog } from '../permissions.js';

const router = express.Router();

const ok = (schema = { type: 'object' }) => ({
  200: { description: 'OK', content: { 'application/json': { schema } } }
});
const arr = { type: 'array', items: { type: 'object' } };
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'string' } });

// [path, method, tag, summary, responseSchema?, pathParams?]
const ROUTES = [
  ['/health', 'get', 'Auth', 'Health check'],
  ['/auth/register', 'post', 'Auth', 'Registrasi perusahaan + cabang + super admin (edge: hanya sekali saat penyiapan)'],
  ['/auth/login', 'post', 'Auth', 'Login email + password (proteksi brute force)'],
  ['/auth/pin-login', 'post', 'Auth', 'Login cepat dengan PIN kasir'],
  ['/auth/pin-users', 'get', 'Auth', 'Daftar kasir untuk layar PIN', arr],
  ['/auth/pin-branches', 'get', 'Auth', 'Daftar cabang untuk layar PIN'],
  ['/auth/refresh', 'post', 'Auth', 'Rotasi refresh token'],
  ['/auth/logout', 'post', 'Auth', 'Logout + revoke refresh token'],
  ['/auth/me', 'get', 'Auth', 'Profil + hak akses pengguna'],
  ['/auth/me/password', 'put', 'Auth', 'Ubah password'],
  ['/auth/me/pin', 'put', 'Auth', 'Ubah PIN kasir'],
  ['/company', 'get', 'Organisasi', 'Profil perusahaan'],
  ['/company', 'put', 'Organisasi', 'Ubah profil perusahaan (pajak, mata uang, logo)'],
  ['/branches', 'get', 'Organisasi', 'Daftar cabang dalam scope pengguna', arr],
  ['/branches', 'post', 'Organisasi', 'Buat cabang baru'],
  ['/branches/{id}', 'get', 'Organisasi', 'Detail cabang', null, ['id']],
  ['/branches/{id}', 'put', 'Organisasi', 'Ubah cabang', null, ['id']],
  ['/branches/{id}', 'delete', 'Organisasi', 'Nonaktifkan cabang', null, ['id']],
  ['/users', 'get', 'Organisasi', 'Daftar pengguna', arr],
  ['/users', 'post', 'Organisasi', 'Tambah pengguna (dengan PIN kasir)'],
  ['/users/{id}', 'put', 'Organisasi', 'Ubah pengguna', null, ['id']],
  ['/users/{id}', 'delete', 'Organisasi', 'Nonaktifkan pengguna', null, ['id']],
  ['/roles', 'get', 'Organisasi', 'Daftar role (built-in + custom)', arr],
  ['/roles', 'post', 'Organisasi', 'Buat role custom'],
  ['/roles/permissions', 'get', 'Organisasi', 'Katalog hak akses'],
  ['/roles/{id}', 'put', 'Organisasi', 'Ubah role & matriks hak akses', null, ['id']],
  ['/roles/{id}', 'delete', 'Organisasi', 'Hapus role custom', null, ['id']],
  ['/categories', 'get', 'Katalog', 'Daftar kategori', arr],
  ['/categories', 'post', 'Katalog', 'Buat kategori'],
  ['/categories/{id}', 'put', 'Katalog', 'Ubah kategori', null, ['id']],
  ['/categories/{id}', 'delete', 'Katalog', 'Hapus kategori', null, ['id']],
  ['/products', 'get', 'Katalog', 'Daftar produk master', arr],
  ['/products', 'post', 'Katalog', 'Buat produk (+ varian inline)'],
  ['/products/upload-image', 'post', 'Katalog', 'Unggah foto produk (base64 data URI) → /uploads/<file>'],
  ['/products/import/fields', 'get', 'Katalog', 'Kolom yang bisa diimpor + kolom wajib'],
  ['/products/import/template.csv', 'get', 'Katalog', 'Unduh template impor produk (CSV)', 'csv'],
  ['/products/import/preview', 'post', 'Katalog', 'Pratinjau impor produk (tanpa menulis)'],
  ['/products/import', 'post', 'Katalog', 'Impor produk dari Excel/CSV (satu transaksi)'],
  ['/products/{id}', 'get', 'Katalog', 'Detail produk + varian', null, ['id']],
  ['/products/{id}', 'put', 'Katalog', 'Ubah produk', null, ['id']],
  ['/products/{id}', 'delete', 'Katalog', 'Nonaktifkan produk', null, ['id']],
  ['/products/{id}/variants', 'get', 'Katalog', 'Daftar varian produk', arr, ['id']],
  ['/products/{id}/variants', 'post', 'Katalog', 'Tambah varian', null, ['id']],
  ['/variants/{id}', 'put', 'Katalog', 'Ubah varian', null, ['id']],
  ['/variants/{id}', 'delete', 'Katalog', 'Hapus varian', null, ['id']],
  ['/branches/{branchId}/catalog', 'get', 'Katalog', 'Katalog POS per cabang (harga override + stok)', arr, ['branchId']],
  ['/branches/{branchId}/products', 'get', 'Katalog', 'Daftar produk + harga cabang', arr, ['branchId']],
  ['/branches/{branchId}/products/{productId}', 'put', 'Katalog', 'Set harga khusus / ketersediaan di cabang', null, ['branchId', 'productId']]
];

const STOCK_TX_ROUTES = [
  ['/branches/{branchId}/stock', 'get', 'Stok', 'Stok per cabang', arr, ['branchId']],
  ['/stock/overview', 'get', 'Stok', 'Matriks stok semua cabang'],
  ['/stock/low', 'get', 'Stok', 'Daftar stok menipis (low stock alert)', arr],
  ['/branches/{branchId}/stock/adjust', 'post', 'Stok', 'Penyesuaian stok manual (set/add/subtract)', null, ['branchId']],
  ['/branches/{branchId}/stock/opname', 'post', 'Stok', 'Stock opname (hasil hitung fisik)', null, ['branchId']],
  ['/branches/{branchId}/stock/{productId}/threshold', 'put', 'Stok', 'Atur batas minimum stok', null, ['branchId', 'productId']],
  ['/branches/{branchId}/movements', 'get', 'Stok', 'Kartu stok / riwayat pergerakan', arr, ['branchId']],
  ['/transfers', 'get', 'Stok', 'Daftar transfer stok', arr],
  ['/transfers', 'post', 'Stok', 'Ajukan transfer stok antar cabang'],
  ['/transfers/{id}', 'get', 'Stok', 'Detail transfer', null, ['id']],
  ['/transfers/{id}/approve', 'post', 'Stok', 'Setujui transfer', null, ['id']],
  ['/transfers/{id}/ship', 'post', 'Stok', 'Kirim barang (kurangi stok asal)', null, ['id']],
  ['/transfers/{id}/receive', 'post', 'Stok', 'Terima barang (partial didukung)', null, ['id']],
  ['/transfers/{id}/reject', 'post', 'Stok', 'Tolak transfer', null, ['id']],
  ['/transactions', 'get', 'Transaksi', 'Riwayat transaksi (filter tanggal/cabang/kasir)'],
  ['/transactions', 'post', 'Transaksi', 'Checkout kasir (idempoten via client_uuid)'],
  ['/transactions/quote', 'post', 'Transaksi', 'Hitung total keranjang tanpa menyimpan'],
  ['/transactions/{id}', 'get', 'Transaksi', 'Detail transaksi', null, ['id']],
  ['/transactions/{id}/void', 'post', 'Transaksi', 'Void transaksi (PIN manager bila kasir)', null, ['id']],
  ['/transactions/{id}/receipt', 'get', 'Transaksi', 'Data struk thermal 58/80mm', null, ['id']]
];

const OPS_REPORT_ROUTES = [
  ['/branches/{branchId}/holds', 'get', 'HoldOrder', 'Daftar hold order cabang', arr, ['branchId']],
  ['/holds', 'post', 'HoldOrder', 'Simpan keranjang (hold order)'],
  ['/holds/{id}', 'get', 'HoldOrder', 'Detail hold order', null, ['id']],
  ['/holds/{id}', 'put', 'HoldOrder', 'Ubah hold order', null, ['id']],
  ['/holds/{id}', 'delete', 'HoldOrder', 'Hapus hold order', null, ['id']],
  ['/shifts/current', 'get', 'Shift', 'Shift aktif pengguna'],
  ['/shifts', 'get', 'Shift', 'Riwayat shift', arr],
  ['/shifts/open', 'post', 'Shift', 'Buka shift + kas awal'],
  ['/shifts/{id}', 'get', 'Shift', 'Rekap shift (X-report)', null, ['id']],
  ['/shifts/{id}/close', 'post', 'Shift', 'Tutup shift (Z-report) + selisih kas', null, ['id']],
  ['/shifts/{id}/handover', 'post', 'Shift', 'Serah terima kas dengan PIN', null, ['id']],
  ['/shifts/{id}/reconcile', 'post', 'Shift', 'Rekonsiliasi selisih oleh manager', null, ['id']],
  ['/devices/register', 'post', 'Perangkat', 'Registrasi perangkat POS (Tauri)'],
  ['/branches/{branchId}/devices', 'get', 'Perangkat', 'Daftar perangkat cabang', arr, ['branchId']],
  ['/devices/{id}/heartbeat', 'post', 'Perangkat', 'Heartbeat perangkat', null, ['id']],
  ['/devices/{id}/remote-logout', 'post', 'Perangkat', 'Remote logout perangkat', null, ['id']],
  ['/devices/{id}', 'put', 'Perangkat', 'Ubah / nonaktifkan perangkat', null, ['id']]
];

const REPORT_SYNC_ROUTES = [
  ['/reports/summary', 'get', 'Laporan', 'KPI dashboard (omzet, laba, metode bayar)'],
  ['/reports/sales', 'get', 'Laporan', 'Perbandingan penjualan antar cabang', arr],
  ['/reports/products', 'get', 'Laporan', 'Produk terlaris / slow moving', arr],
  ['/reports/cashiers', 'get', 'Laporan', 'Performa kasir', arr],
  ['/reports/profit', 'get', 'Laporan', 'Laba rugi + tren harian'],
  ['/reports/export/transactions.csv', 'get', 'Laporan', 'Export transaksi (CSV)', 'csv'],
  ['/reports/export/products.csv', 'get', 'Laporan', 'Export penjualan produk (CSV)', 'csv'],
  ['/reports/export/stock.csv', 'get', 'Laporan', 'Export stok (CSV)', 'csv'],
  ['/reports/export/shifts.csv', 'get', 'Laporan', 'Export shift (CSV)', 'csv'],
  ['/sync/bootstrap', 'get', 'Sinkronisasi', 'Snapshot offline (produk, varian, stok, role kustom, setting)'],
  ['/sync/batch', 'post', 'Sinkronisasi', 'Kirim batch transaksi offline'],
  ['/sync/status', 'get', 'Sinkronisasi', 'Status antrean sinkronisasi'],
  ['/sync/conflicts', 'get', 'Sinkronisasi', 'Daftar konflik sinkronisasi', arr],
  ['/audit-logs', 'get', 'Audit', 'Audit log aktivitas'],
  ['/audit-logs/actions', 'get', 'Audit', 'Daftar jenis aksi audit', arr],
  ['/permissions', 'get', 'Organisasi', 'Katalog hak akses']
];

const PUBLIC_PATHS = new Set([
  '/health', '/auth/register', '/auth/login', '/auth/pin-login', '/auth/pin-users', '/auth/pin-branches', '/auth/refresh'
]);

function buildPaths() {
  const paths = {};
  const all = [...ROUTES, ...STOCK_TX_ROUTES, ...OPS_REPORT_ROUTES, ...REPORT_SYNC_ROUTES];
  for (const [path, method, tag, summary, schema, params] of all) {
    if (!paths[path]) paths[path] = {};
    const op = {
      tags: [tag],
      summary,
      responses: schema === 'csv' ? { 200: { description: 'CSV file' } } : ok(schema || undefined)
    };
    if (params) op.parameters = params.map(idParam);
    if (PUBLIC_PATHS.has(path)) op.security = [];
    paths[path][method] = op;
  }
  return paths;
}

/** Minimal OpenAPI 3 document so the API is self-documenting at /api/openapi.json. */
router.get('/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Reekas POS API',
      version: '1.0.0',
      description:
        'REST API aplikasi POS multi-cabang: autentikasi PIN, katalog produk & varian, stok per cabang, transfer stok, checkout, hold order, shift kas, laporan, sinkronisasi offline, dan audit log.'
    },
    servers: [{ url: '/api', description: 'Current server' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth' }, { name: 'Organisasi' }, { name: 'Katalog' }, { name: 'Stok' },
      { name: 'Transaksi' }, { name: 'HoldOrder' }, { name: 'Shift' }, { name: 'Perangkat' },
      { name: 'Laporan' }, { name: 'Sinkronisasi' }, { name: 'Audit' }
    ],
    paths: buildPaths()
  });
});

/** GET /permissions — permission catalog (same payload as /roles/permissions). */
router.get('/permissions', (req, res) => res.json(catalog()));

export default router;
