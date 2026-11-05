// Product import column definitions shared by the template, the preview and the
// apply endpoint.
//
// Kept in its own module because both the backend (validation/mapping) and the
// generated CSV template need the same list in the same order — a template whose
// columns drift from the importer is the classic way this feature rots.
//
// No dependency on express/db here on purpose: the browser-safe parts (field list
// and the parser) stay importable from plain Node scripts and tests.

/**
 * One importable column.
 *
 * - `label`   — header written into the template (Indonesian CSV), also the
 *               default column label shown in the mapping UI.
 * - `aliases` — lowercased header fragments used for auto-mapping. Keep them
 *               short and distinctive: a loose alias ("harga") would swallow the
 *               wrong column ("harga jual" vs "harga modal").
 * - `required`— the importer refuses a mapping that leaves these unmapped, and a
 *               row that leaves them empty.
 * - `kind`    — drives parsing and the CSV example value.
 */
export const PRODUCT_IMPORT_FIELDS = [
  {
    key: 'name',
    label: 'Nama Produk',
    aliases: ['nama produk', 'nama', 'name', 'product name', 'item', 'produk'],
    required: true,
    kind: 'text',
    example: 'Kopi Susu Gula Aren'
  },
  {
    key: 'category',
    label: 'Kategori',
    aliases: ['kategori', 'category', 'group', 'kategori produk'],
    required: false,
    kind: 'text',
    example: 'Minuman'
  },
  {
    key: 'sku',
    label: 'SKU',
    aliases: ['sku', 'kode', 'kode produk', 'product code', 'kode barang'],
    required: false,
    kind: 'text',
    example: 'KOP-SUSU-01'
  },
  {
    key: 'barcode',
    label: 'Barcode',
    aliases: ['barcode', 'barkode', 'ean', 'upc'],
    required: false,
    kind: 'text',
    example: '8991234567890'
  },
  {
    key: 'unit',
    label: 'Satuan',
    aliases: ['satuan', 'unit', 'uom', 'satuan jual'],
    required: false,
    kind: 'text',
    example: 'pcs'
  },
  {
    key: 'cost_price',
    label: 'Harga Modal',
    aliases: ['harga modal', 'modal', 'cost', 'cost price', 'hpp', 'harga beli'],
    required: false,
    kind: 'money',
    example: '9000'
  },
  {
    key: 'default_price',
    label: 'Harga Jual',
    aliases: ['harga jual', 'harga', 'price', 'sell price', 'selling price', 'harga jual (rp)'],
    required: true,
    kind: 'money',
    example: '18000'
  },
  {
    key: 'description',
    label: 'Deskripsi',
    aliases: ['deskripsi', 'keterangan', 'description', 'note', 'catatan'],
    required: false,
    kind: 'text',
    example: 'Es kopi susu dengan gula aren'
  },
  {
    key: 'brand',
    label: 'Merek',
    aliases: ['merek', 'merk', 'brand', 'label'],
    required: false,
    kind: 'text',
    example: ''
  },
  {
    key: 'is_active',
    label: 'Status',
    aliases: ['status', 'aktif', 'is active', 'active', 'status aktif'],
    required: false,
    kind: 'status',
    example: 'aktif'
  },
  {
    key: 'variants',
    label: 'Varian',
    aliases: ['varian', 'variants', 'variant', 'opsi', 'pilihan'],
    required: false,
    kind: 'variants',
    example: 'Ukuran:Reguler=0;Ukuran:Large=4000'
  },
  {
    key: 'stock',
    label: 'Stok Awal',
    aliases: ['stok', 'stok awal', 'stock', 'qty', 'quantity', 'stok (pcs)'],
    required: false,
    kind: 'number',
    example: ''
  }
];

/** Field keys in template order. */
export const PRODUCT_IMPORT_KEYS = PRODUCT_IMPORT_FIELDS.map((f) => f.key);

/** Fields the importer cannot work without. */
export const REQUIRED_IMPORT_KEYS = PRODUCT_IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
