// Central permission catalog. The Super Admin can build custom roles from this
// matrix; the frontend uses the same list to render the permission checkboxes.
export const PERMISSION_GROUPS = [
  {
    group: 'Perusahaan',
    items: [
      { key: 'company.manage', label: 'Kelola data perusahaan' },
      { key: 'branch.manage', label: 'Buat / ubah / nonaktifkan cabang' },
      { key: 'device.manage', label: 'Kelola perangkat & remote logout' },
      { key: 'audit.view', label: 'Lihat audit log' }
    ]
  },
  {
    group: 'Pengguna & Role',
    items: [
      { key: 'user.manage', label: 'Kelola semua pengguna' },
      { key: 'user.manage_branch', label: 'Kelola pengguna cabang sendiri' },
      { key: 'role.manage', label: 'Kelola role & matriks hak akses' }
    ]
  },
  {
    group: 'Produk & Stok',
    items: [
      { key: 'product.manage', label: 'Kelola katalog produk master & varian' },
      { key: 'product.view_cost', label: 'Lihat harga modal' },
      { key: 'stock.manage', label: 'Sesuaikan stok & stok opname' },
      { key: 'stock.transfer', label: 'Buat / setujui transfer stok antar cabang' },
      { key: 'stock.view', label: 'Lihat stok cabang' }
    ]
  },
  {
    group: 'Transaksi',
    items: [
      { key: 'transaction.create', label: 'Buat transaksi (checkout kasir)' },
      { key: 'transaction.void', label: 'Void / retur transaksi' },
      { key: 'transaction.void_approve', label: 'Menyetujui permintaan void' },
      { key: 'transaction.discount', label: 'Memberi diskon transaksi' },
      { key: 'transaction.view_all', label: 'Lihat transaksi semua kasir' },
      { key: 'hold.manage', label: 'Kelola hold order' }
    ]
  },
  {
    group: 'Shift & Kas',
    items: [
      { key: 'shift.manage', label: 'Buka / tutup shift semua kasir' },
      { key: 'shift.manage_own', label: 'Buka / tutup shift sendiri' },
      { key: 'shift.handover', label: 'Ganti kasir dengan PIN (handover)' },
      { key: 'shift.reconcile', label: 'Rekonsiliasi selisih kas shift' }
    ]
  },
  {
    group: 'Laporan',
    items: [
      { key: 'report.view_all', label: 'Laporan konsolidasi semua cabang' },
      { key: 'report.view_branch', label: 'Laporan cabang sendiri' },
      { key: 'report.view_profit', label: 'Lihat laba / rugi' },
      { key: 'report.export', label: 'Export laporan (CSV / PDF)' }
    ]
  }
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

// Built-in roles. Custom roles created by the Super Admin live in the `roles` table.
export const ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS.slice(),
  manager: [
    'product.manage', 'product.view_cost', 'stock.manage', 'stock.transfer', 'stock.view',
    'transaction.create', 'transaction.void', 'transaction.void_approve', 'transaction.discount',
    'transaction.view_all', 'hold.manage', 'shift.manage', 'shift.handover', 'shift.reconcile',
    'report.view_branch', 'report.view_profit', 'report.export',
    'user.manage_branch', 'audit.view', 'device.manage'
  ],
  cashier: [
    'transaction.create', 'transaction.discount', 'hold.manage',
    'shift.manage_own', 'shift.handover', 'stock.view'
  ],
  warehouse: ['stock.manage', 'stock.transfer', 'stock.view', 'product.manage']
};

export const BUILTIN_ROLE_LABELS = {
  super_admin: 'Super Admin (Pemilik)',
  manager: 'Manager Cabang',
  cashier: 'Kasir / Staff',
  warehouse: 'Staff Gudang'
};

export function catalog() {
  return {
    groups: PERMISSION_GROUPS,
    permissions: ALL_PERMISSIONS,
    builtin_roles: Object.entries(BUILTIN_ROLE_LABELS).map(([key, label]) => ({
      key,
      label,
      permissions: ROLE_PERMISSIONS[key] || []
    }))
  };
}
