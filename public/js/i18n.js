/**
 * MCT i18n — client-side translation
 * Languages: en (English), zh (Chinese Simplified), bm (Bahasa Malaysia)
 *
 * Usage:
 *   i18n.t('key')              — translate key in current language
 *   i18n.setLang('zh')         — switch language and re-render page
 *   i18n.apply()               — apply translations to all data-i18n elements
 */
(function (window) {
  'use strict';

  const STORAGE_KEY = 'mct_lang';
  const DEFAULT_LANG = 'en';
  const SUPPORTED = ['en', 'zh', 'bm'];

  // ─── Translation dictionary ───────────────────────────────────────────────
  const dict = {
    en: {
      // ── Header / nav ──────────────────────────────────────────────────────
      'nav.dashboard':        'Dashboard',
      'nav.apikeys':          'API Keys',
      'nav.cashwallet':       'Cash Wallet',
      'nav.chart':            'Chart',
      'nav.profile':          'Profile',
      'nav.admin':            'Admin',
      'header.logout':        'Log Out',
      'header.botactive':     'Bot Active',
      'header.botpaused':     'Bot Paused',
      'header.pausebot':      'Pause Bot',
      'header.resumebot':     'Resume Bot',

      // ── Network widget ─────────────────────────────────────────────────────
      'widget.networkstatus': 'Network Status',
      'widget.live':          'Live',

      // ── Dashboard cards ────────────────────────────────────────────────────
      'dash.cashwallet':          'Cash Wallet',
      'dash.referralcommission':  'Referral Commission',
      'dash.totalpnl':            'Total P&L',
      'dash.24hpnl':              '24h P&L',
      'dash.7dpnl':               '7d P&L',
      'dash.winrate':             'Win Rate',
      'dash.wins':                'Wins',
      'dash.losses':              'Losses',
      'dash.opentrades':          'Open Trades',
      'dash.totalwon':            'Total Won',
      'dash.totallost':           'Total Lost',

      // ── Pause banner ───────────────────────────────────────────────────────
      'pause.active':   'Bot Active',
      'pause.paused':   'Bot Paused',
      'pause.pause':    'Pause Bot',
      'pause.resume':   'Resume Bot',

      // ── Kronos ─────────────────────────────────────────────────────────────
      'kronos.title':   'Kronos AI Predictions',
      'kronos.refresh': 'Refresh',
      'kronos.bullish': 'Bullish',
      'kronos.bearish': 'Bearish',
      'kronos.neutral': 'Neutral',

      // ── Weekly earnings ────────────────────────────────────────────────────
      'weekly.title':       "This Week's Earnings",
      'weekly.duein':       'Due in',
      'weekly.paynow':      'Pay Now',
      'weekly.yourearnings':'Your Earnings',
      'weekly.platformfee': 'Platform Fee',
      'weekly.netpnl':      'Net P&L',
      'weekly.weekrecord':  'Week Record',
      'weekly.wl':          'W / L this week',

      // ── Trade history ──────────────────────────────────────────────────────
      'trade.history':  'Trade History',
      'trade.date':     'Date',
      'trade.symbol':   'Symbol',
      'trade.dir':      'Dir',
      'trade.entry':    'Entry',
      'trade.exit':     'Exit',
      'trade.grosspnl': 'Gross P&L',
      'trade.fee':      'Fee',
      'trade.funding':  'Funding',
      'trade.netpnl':   'Net P&L',
      'trade.status':   'Status',
      'trade.platform': 'Platform',
      'trade.notrades': 'No trades yet',
      'trade.tradesub': 'Trades will appear here once your bot starts executing.',
      'trade.clearerrors': 'Clear Errors',
      'trade.downloadcsv': 'Download CSV',

      // ── Period filters ─────────────────────────────────────────────────────
      'period.all': 'All',
      'period.1d':  '1 Day',
      'period.7d':  '7 Days',
      'period.30d': '30 Days',
      'period.6m':  '6 Months',
      'period.1y':  '1 Year',

      // ── Token panel ────────────────────────────────────────────────────────
      'tokens.mytokens':    'My Tokens',
      'tokens.allon':       'All ON',
      'tokens.alloff':      'All OFF',
      'tokens.refresh':     'Refresh',
      'tokens.todayresults':'Today\'s Results',
      'tokens.loading':     'Loading tokens...',
      'tokens.noresults':   'No results yet today',

      // ── Pagination ─────────────────────────────────────────────────────────
      'page.prev': '← Prev',
      'page.next': 'Next →',

      // ── API Keys tab ───────────────────────────────────────────────────────
      'keys.title':   'Your API Keys',
      'keys.addkey':  '+ Add Key',
      'keys.empty':   'No API keys configured',
      'keys.emptysub':'Add your exchange API key to start automated trading.',

      // ── Cash Wallet tab ────────────────────────────────────────────────────
      'cw.title':           'Cash Wallet',
      'cw.balance':         'Cash Wallet Balance',
      'cw.balancesub':      'Top-ups + referral commissions',
      'cw.commission':      'Commission Earned',
      'cw.commissionsub':   'Referral earnings (auto-added to wallet)',
      'cw.topuptitle':      'Top Up Cash Wallet',
      'cw.amount':          'Amount (USDT)',
      'cw.txhash':          'TX Hash / Proof URL',
      'cw.submittopup':     'Submit Top-Up',
      'cw.withdrawaddr':    'USDT Withdrawal Address',
      'cw.usdtaddr':        'USDT Address',
      'cw.network':         'Network',
      'cw.saveaddr':        'Save Address',
      'cw.addrnote':        'Commission withdrawals are sent as USDT only. No bank transfers.',
      'cw.withdrawtitle':   'Withdraw (USDT)',
      'cw.withdrawmin':     'Amount (min $10)',
      'cw.requestwd':       'Request Withdrawal',
      'cw.referraltitle':   'Your Referral Link',
      'cw.copy':            'Copy',
      'cw.referrals':       'Referrals:',
      'cw.totalearned':     'Total Earned:',
      'cw.txthistory':      'Transaction History',
      'cw.wdhistory':       'Withdrawal History',
      'cw.loading':         'Loading...',
      'cw.referralnote':    'Earn weekly commission from your referrals\' profits. Paid when admin settles each week.',
      'cw.bitunixlink':     '🔵 Your Bitunix Referral Link',
      'cw.save':            'Save',

      // ── Profile tab ────────────────────────────────────────────────────────
      'profile.title':        'Profile Settings',
      'profile.accountinfo':  'Account Info',
      'profile.username':     'Username',
      'profile.email':        'Email',
      'profile.saveprofile':  'Save Profile',
      'profile.changepasswd': 'Change Password',
      'profile.currentpw':    'Current Password',
      'profile.newpw':        'New Password',
      'profile.confirmpw':    'Confirm New Password',
      'profile.changepw':     'Change Password',

      // ── Admin panel ────────────────────────────────────────────────────────
      'admin.title':          'Admin Panel',
      'admin.earnings':       'Earnings',
      'admin.users':          'Users',
      'admin.tokens':         'Tokens',
      'admin.settings':       'Settings',
      'admin.tools':          'Tools',
      'admin.email':          '✉️ Email',
      'admin.tradingfloor':   '🎮 Trading Floor',
      'admin.netpnl':         'Net P&L (All Users)',
      'admin.adminshare':     'Admin Share',
      'admin.usershare':      'User Share',
      'admin.emergency':      'Emergency Close Positions',
      'admin.refresh':        'Refresh',
      'admin.closeall':       'CLOSE ALL',
      'admin.fixcorrupted':   'Fix Corrupted Trades',
      'admin.resyncfees':     'Resync Fees',
      'admin.cleartest':      'Clear Test Data',
      'admin.userstable':     'Users',
      'admin.pendingpayments':'Pending Payments',
      'admin.pendingwd':      'Pending Withdrawals',

      // ── Admin table headers ────────────────────────────────────────────────
      'th.email':   'Email',
      'th.keys':    'Keys',
      'th.wallet':  'Wallet',
      'th.referral':'Referral',
      'th.joined':  'Joined',
      'th.payment': 'Payment',
      'th.action':  'Action',
      'th.user':    'User',
      'th.amount':  'Amount',
      'th.method':  'Method',
      'th.proof':   'Proof',
      'th.date':    'Date',
      'th.bank':    'Bank',
      'th.accno':   'Acc No.',
      'th.name':    'Name',

      // ── Auth / login ────────────────────────────────────────────────────────
      'auth.login':         'Login',
      'auth.signup':        'Sign Up',
      'auth.email':         'Email',
      'auth.password':      'Password',
      'auth.loginbtn':      'Login',
      'auth.signupbtn':     'Create Account',
      'auth.forgotpw':      'Forgot password?',
      'auth.haveaccount':   'Already have an account?',
      'auth.noaccount':     "Don't have an account?",

      // ── Toast / misc ───────────────────────────────────────────────────────
      'toast.copied':       'Copied!',
      'toast.addrcopy':     'Address copied!',
      'toast.saved':        'Saved!',
      'toast.error':        'An error occurred',
      'misc.loading':       'Loading...',
      'misc.days':          'days',
      'misc.hrs':           'hrs',
      'misc.min':           'min',
      'misc.sec':           'sec',
    },

    // ─── Chinese Simplified ─────────────────────────────────────────────────
    zh: {
      'nav.dashboard':        '控制台',
      'nav.apikeys':          'API 密钥',
      'nav.cashwallet':       '现金钱包',
      'nav.chart':            '图表',
      'nav.profile':          '个人资料',
      'nav.admin':            '管理员',
      'header.logout':        '退出登录',
      'header.botactive':     '机器人运行中',
      'header.botpaused':     '机器人已暂停',
      'header.pausebot':      '暂停机器人',
      'header.resumebot':     '恢复机器人',

      'widget.networkstatus': '网络状态',
      'widget.live':          '实时',

      'dash.cashwallet':          '现金钱包',
      'dash.referralcommission':  '推荐佣金',
      'dash.totalpnl':            '总盈亏',
      'dash.24hpnl':              '24小时盈亏',
      'dash.7dpnl':               '7天盈亏',
      'dash.winrate':             '胜率',
      'dash.wins':                '盈利次数',
      'dash.losses':              '亏损次数',
      'dash.opentrades':          '持仓中',
      'dash.totalwon':            '总盈利',
      'dash.totallost':           '总亏损',

      'pause.active':   '机器人运行中',
      'pause.paused':   '机器人已暂停',
      'pause.pause':    '暂停机器人',
      'pause.resume':   '恢复机器人',

      'kronos.title':   'Kronos AI 预测',
      'kronos.refresh': '刷新',
      'kronos.bullish': '看涨',
      'kronos.bearish': '看跌',
      'kronos.neutral': '中性',

      'weekly.title':       '本周收益',
      'weekly.duein':       '到期',
      'weekly.paynow':      '立即支付',
      'weekly.yourearnings':'您的收益',
      'weekly.platformfee': '平台费用',
      'weekly.netpnl':      '净盈亏',
      'weekly.weekrecord':  '本周战绩',
      'weekly.wl':          '胜/负 本周',

      'trade.history':  '交易记录',
      'trade.date':     '日期',
      'trade.symbol':   '币种',
      'trade.dir':      '方向',
      'trade.entry':    '开仓价',
      'trade.exit':     '平仓价',
      'trade.grosspnl': '毛利润',
      'trade.fee':      '手续费',
      'trade.funding':  '资金费',
      'trade.netpnl':   '净盈亏',
      'trade.status':   '状态',
      'trade.platform': '平台',
      'trade.notrades': '暂无交易',
      'trade.tradesub': '机器人开始交易后，记录将显示在此处。',
      'trade.clearerrors': '清除错误',
      'trade.downloadcsv': '下载 CSV',

      'period.all': '全部',
      'period.1d':  '1天',
      'period.7d':  '7天',
      'period.30d': '30天',
      'period.6m':  '6个月',
      'period.1y':  '1年',

      'tokens.mytokens':    '我的代币',
      'tokens.allon':       '全部开启',
      'tokens.alloff':      '全部关闭',
      'tokens.refresh':     '刷新',
      'tokens.todayresults':'今日结果',
      'tokens.loading':     '加载代币中...',
      'tokens.noresults':   '今日暂无结果',

      'page.prev': '← 上一页',
      'page.next': '下一页 →',

      'keys.title':   '您的 API 密钥',
      'keys.addkey':  '+ 添加密钥',
      'keys.empty':   '尚未配置 API 密钥',
      'keys.emptysub':'添加交易所 API 密钥以开始自动交易。',

      'cw.title':           '现金钱包',
      'cw.balance':         '现金钱包余额',
      'cw.balancesub':      '充值 + 推荐佣金',
      'cw.commission':      '已获佣金',
      'cw.commissionsub':   '推荐收益（自动添加至钱包）',
      'cw.topuptitle':      '充值现金钱包',
      'cw.amount':          '金额（USDT）',
      'cw.txhash':          '交易哈希 / 截图链接',
      'cw.submittopup':     '提交充值',
      'cw.withdrawaddr':    'USDT 提现地址',
      'cw.usdtaddr':        'USDT 地址',
      'cw.network':         '网络',
      'cw.saveaddr':        '保存地址',
      'cw.addrnote':        '佣金提现仅支持 USDT。不支持银行转账。',
      'cw.withdrawtitle':   '提现（USDT）',
      'cw.withdrawmin':     '金额（最低 $10）',
      'cw.requestwd':       '申请提现',
      'cw.referraltitle':   '您的推荐链接',
      'cw.copy':            '复制',
      'cw.referrals':       '推荐人数：',
      'cw.totalearned':     '总收益：',
      'cw.txthistory':      '交易记录',
      'cw.wdhistory':       '提现记录',
      'cw.loading':         '加载中...',
      'cw.referralnote':    '赚取推荐人每周利润的佣金，每周结算后发放。',
      'cw.bitunixlink':     '🔵 您的 Bitunix 推荐链接',
      'cw.save':            '保存',

      'profile.title':        '个人资料设置',
      'profile.accountinfo':  '账户信息',
      'profile.username':     '用户名',
      'profile.email':        '邮箱',
      'profile.saveprofile':  '保存资料',
      'profile.changepasswd': '修改密码',
      'profile.currentpw':    '当前密码',
      'profile.newpw':        '新密码',
      'profile.confirmpw':    '确认新密码',
      'profile.changepw':     '修改密码',

      'admin.title':          '管理员面板',
      'admin.earnings':       '收益',
      'admin.users':          '用户',
      'admin.tokens':         '代币',
      'admin.settings':       '设置',
      'admin.tools':          '工具',
      'admin.email':          '✉️ 邮件',
      'admin.tradingfloor':   '🎮 交易大厅',
      'admin.netpnl':         '净盈亏（全部用户）',
      'admin.adminshare':     '管理员分成',
      'admin.usershare':      '用户分成',
      'admin.emergency':      '紧急平仓',
      'admin.refresh':        '刷新',
      'admin.closeall':       '全部平仓',
      'admin.fixcorrupted':   '修复损坏交易',
      'admin.resyncfees':     '重新同步费用',
      'admin.cleartest':      '清除测试数据',
      'admin.userstable':     '用户',
      'admin.pendingpayments':'待处理付款',
      'admin.pendingwd':      '待处理提现',

      'th.email':   '邮箱',
      'th.keys':    '密钥',
      'th.wallet':  '钱包',
      'th.referral':'推荐',
      'th.joined':  '注册时间',
      'th.payment': '付款',
      'th.action':  '操作',
      'th.user':    '用户',
      'th.amount':  '金额',
      'th.method':  '方式',
      'th.proof':   '凭证',
      'th.date':    '日期',
      'th.bank':    '银行',
      'th.accno':   '账号',
      'th.name':    '姓名',

      'auth.login':         '登录',
      'auth.signup':        '注册',
      'auth.email':         '邮箱',
      'auth.password':      '密码',
      'auth.loginbtn':      '登录',
      'auth.signupbtn':     '创建账户',
      'auth.forgotpw':      '忘记密码？',
      'auth.haveaccount':   '已有账户？',
      'auth.noaccount':     '没有账户？',

      'toast.copied':       '已复制！',
      'toast.addrcopy':     '地址已复制！',
      'toast.saved':        '已保存！',
      'toast.error':        '发生错误',
      'misc.loading':       '加载中...',
      'misc.days':          '天',
      'misc.hrs':           '时',
      'misc.min':           '分',
      'misc.sec':           '秒',
    },

    // ─── Bahasa Malaysia ────────────────────────────────────────────────────
    bm: {
      'nav.dashboard':        'Papan Pemuka',
      'nav.apikeys':          'Kunci API',
      'nav.cashwallet':       'Dompet Tunai',
      'nav.chart':            'Carta',
      'nav.profile':          'Profil',
      'nav.admin':            'Admin',
      'header.logout':        'Log Keluar',
      'header.botactive':     'Bot Aktif',
      'header.botpaused':     'Bot Dijeda',
      'header.pausebot':      'Jeda Bot',
      'header.resumebot':     'Sambung Bot',

      'widget.networkstatus': 'Status Rangkaian',
      'widget.live':          'Langsung',

      'dash.cashwallet':          'Dompet Tunai',
      'dash.referralcommission':  'Komisen Rujukan',
      'dash.totalpnl':            'Jumlah P&L',
      'dash.24hpnl':              'P&L 24 Jam',
      'dash.7dpnl':               'P&L 7 Hari',
      'dash.winrate':             'Kadar Menang',
      'dash.wins':                'Menang',
      'dash.losses':              'Kalah',
      'dash.opentrades':          'Dagangan Terbuka',
      'dash.totalwon':            'Jumlah Menang',
      'dash.totallost':           'Jumlah Kalah',

      'pause.active':   'Bot Aktif',
      'pause.paused':   'Bot Dijeda',
      'pause.pause':    'Jeda Bot',
      'pause.resume':   'Sambung Bot',

      'kronos.title':   'Ramalan AI Kronos',
      'kronos.refresh': 'Muat Semula',
      'kronos.bullish': 'Naik',
      'kronos.bearish': 'Turun',
      'kronos.neutral': 'Neutral',

      'weekly.title':       'Pendapatan Minggu Ini',
      'weekly.duein':       'Perlu dibayar dalam',
      'weekly.paynow':      'Bayar Sekarang',
      'weekly.yourearnings':'Pendapatan Anda',
      'weekly.platformfee': 'Yuran Platform',
      'weekly.netpnl':      'P&L Bersih',
      'weekly.weekrecord':  'Rekod Minggu',
      'weekly.wl':          'M / K minggu ini',

      'trade.history':  'Sejarah Dagangan',
      'trade.date':     'Tarikh',
      'trade.symbol':   'Simbol',
      'trade.dir':      'Arah',
      'trade.entry':    'Masuk',
      'trade.exit':     'Keluar',
      'trade.grosspnl': 'P&L Kasar',
      'trade.fee':      'Yuran',
      'trade.funding':  'Pembiayaan',
      'trade.netpnl':   'P&L Bersih',
      'trade.status':   'Status',
      'trade.platform': 'Platform',
      'trade.notrades': 'Tiada dagangan lagi',
      'trade.tradesub': 'Dagangan akan muncul di sini apabila bot mula beroperasi.',
      'trade.clearerrors': 'Padam Ralat',
      'trade.downloadcsv': 'Muat Turun CSV',

      'period.all': 'Semua',
      'period.1d':  '1 Hari',
      'period.7d':  '7 Hari',
      'period.30d': '30 Hari',
      'period.6m':  '6 Bulan',
      'period.1y':  '1 Tahun',

      'tokens.mytokens':    'Token Saya',
      'tokens.allon':       'Semua HIDUP',
      'tokens.alloff':      'Semua MATI',
      'tokens.refresh':     'Muat Semula',
      'tokens.todayresults':'Keputusan Hari Ini',
      'tokens.loading':     'Memuatkan token...',
      'tokens.noresults':   'Tiada keputusan hari ini',

      'page.prev': '← Sebelum',
      'page.next': 'Seterusnya →',

      'keys.title':   'Kunci API Anda',
      'keys.addkey':  '+ Tambah Kunci',
      'keys.empty':   'Tiada kunci API dikonfigurasi',
      'keys.emptysub':'Tambah kunci API pertukaran anda untuk mula dagangan automatik.',

      'cw.title':           'Dompet Tunai',
      'cw.balance':         'Baki Dompet Tunai',
      'cw.balancesub':      'Tambah nilai + komisen rujukan',
      'cw.commission':      'Komisen Diperoleh',
      'cw.commissionsub':   'Pendapatan rujukan (ditambah ke dompet secara automatik)',
      'cw.topuptitle':      'Tambah Nilai Dompet Tunai',
      'cw.amount':          'Jumlah (USDT)',
      'cw.txhash':          'Hash TX / URL Bukti',
      'cw.submittopup':     'Hantar Tambah Nilai',
      'cw.withdrawaddr':    'Alamat Pengeluaran USDT',
      'cw.usdtaddr':        'Alamat USDT',
      'cw.network':         'Rangkaian',
      'cw.saveaddr':        'Simpan Alamat',
      'cw.addrnote':        'Pengeluaran komisen dihantar dalam USDT sahaja. Tiada pindahan bank.',
      'cw.withdrawtitle':   'Pengeluaran (USDT)',
      'cw.withdrawmin':     'Jumlah (min $10)',
      'cw.requestwd':       'Minta Pengeluaran',
      'cw.referraltitle':   'Pautan Rujukan Anda',
      'cw.copy':            'Salin',
      'cw.referrals':       'Rujukan:',
      'cw.totalearned':     'Jumlah Diperoleh:',
      'cw.txthistory':      'Sejarah Transaksi',
      'cw.wdhistory':       'Sejarah Pengeluaran',
      'cw.loading':         'Memuatkan...',
      'cw.referralnote':    'Dapatkan komisen mingguan daripada keuntungan rujukan anda. Dibayar setiap minggu oleh admin.',
      'cw.bitunixlink':     '🔵 Pautan Rujukan Bitunix Anda',
      'cw.save':            'Simpan',

      'profile.title':        'Tetapan Profil',
      'profile.accountinfo':  'Maklumat Akaun',
      'profile.username':     'Nama Pengguna',
      'profile.email':        'E-mel',
      'profile.saveprofile':  'Simpan Profil',
      'profile.changepasswd': 'Tukar Kata Laluan',
      'profile.currentpw':    'Kata Laluan Semasa',
      'profile.newpw':        'Kata Laluan Baru',
      'profile.confirmpw':    'Sahkan Kata Laluan Baru',
      'profile.changepw':     'Tukar Kata Laluan',

      'admin.title':          'Panel Admin',
      'admin.earnings':       'Pendapatan',
      'admin.users':          'Pengguna',
      'admin.tokens':         'Token',
      'admin.settings':       'Tetapan',
      'admin.tools':          'Alatan',
      'admin.email':          '✉️ E-mel',
      'admin.tradingfloor':   '🎮 Lantai Dagangan',
      'admin.netpnl':         'P&L Bersih (Semua Pengguna)',
      'admin.adminshare':     'Bahagian Admin',
      'admin.usershare':      'Bahagian Pengguna',
      'admin.emergency':      'Tutup Kedudukan Kecemasan',
      'admin.refresh':        'Muat Semula',
      'admin.closeall':       'TUTUP SEMUA',
      'admin.fixcorrupted':   'Betulkan Dagangan Rosak',
      'admin.resyncfees':     'Segerak Semula Yuran',
      'admin.cleartest':      'Padam Data Ujian',
      'admin.userstable':     'Pengguna',
      'admin.pendingpayments':'Pembayaran Tertangguh',
      'admin.pendingwd':      'Pengeluaran Tertangguh',

      'th.email':   'E-mel',
      'th.keys':    'Kunci',
      'th.wallet':  'Dompet',
      'th.referral':'Rujukan',
      'th.joined':  'Tarikh Daftar',
      'th.payment': 'Pembayaran',
      'th.action':  'Tindakan',
      'th.user':    'Pengguna',
      'th.amount':  'Jumlah',
      'th.method':  'Kaedah',
      'th.proof':   'Bukti',
      'th.date':    'Tarikh',
      'th.bank':    'Bank',
      'th.accno':   'No. Akaun',
      'th.name':    'Nama',

      'auth.login':         'Log Masuk',
      'auth.signup':        'Daftar',
      'auth.email':         'E-mel',
      'auth.password':      'Kata Laluan',
      'auth.loginbtn':      'Log Masuk',
      'auth.signupbtn':     'Buat Akaun',
      'auth.forgotpw':      'Lupa kata laluan?',
      'auth.haveaccount':   'Sudah ada akaun?',
      'auth.noaccount':     'Belum ada akaun?',

      'toast.copied':       'Disalin!',
      'toast.addrcopy':     'Alamat disalin!',
      'toast.saved':        'Disimpan!',
      'toast.error':        'Ralat berlaku',
      'misc.loading':       'Memuatkan...',
      'misc.days':          'hari',
      'misc.hrs':           'jam',
      'misc.min':           'min',
      'misc.sec':           'saat',
    },
  };

  // ─── Language flags / labels for the switcher ─────────────────────────────
  const LANG_META = {
    en: { label: 'EN', flag: '🇬🇧', name: 'English' },
    zh: { label: '中文', flag: '🇨🇳', name: '中文 (简体)' },
    bm: { label: 'BM', flag: '🇲🇾', name: 'Bahasa Melayu' },
  };

  // ─── Core ─────────────────────────────────────────────────────────────────
  let _lang = DEFAULT_LANG;

  function getLang() {
    return _lang;
  }

  function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    _lang = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    apply();
    _updateSwitcher();
    document.documentElement.lang = lang;
  }

  /** Translate a key; returns key itself when not found (fallback to EN then raw key). */
  function t(key) {
    return (dict[_lang] && dict[_lang][key])
      || (dict.en && dict.en[key])
      || key;
  }

  /** Apply translations to all [data-i18n] elements in the document. */
  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      const key = el.getAttribute('data-i18n');
      const target = el.getAttribute('data-i18n-target') || 'textContent';
      const text = t(key);
      if (target === 'placeholder') {
        el.placeholder = text;
      } else if (target === 'title') {
        el.title = text;
      } else if (target === 'aria-label') {
        el.setAttribute('aria-label', text);
      } else {
        // Only set if the element has no children, or force-replace flag is set
        if (!el.children.length || el.getAttribute('data-i18n-force') === 'true') {
          el.textContent = text;
        }
      }
    });
  }

  // ─── Language switcher UI ─────────────────────────────────────────────────
  function createSwitcher() {
    const wrap = document.createElement('div');
    wrap.id = 'i18n-switcher';
    wrap.style.cssText = [
      'position:relative',
      'display:inline-flex',
      'align-items:center',
    ].join(';');

    const btn = document.createElement('button');
    btn.id = 'i18n-btn';
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.cssText = 'font-size:0.78rem;padding:4px 10px;min-height:30px;gap:4px;display:inline-flex;align-items:center;border:1px solid var(--color-border);';
    btn.setAttribute('aria-label', 'Switch language');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    const dropdown = document.createElement('div');
    dropdown.id = 'i18n-dropdown';
    dropdown.style.cssText = [
      'display:none',
      'position:absolute',
      'top:calc(100% + 4px)',
      'right:0',
      'min-width:160px',
      'background:var(--color-bg-raised)',
      'border:1px solid var(--color-border)',
      'border-radius:var(--radius-md)',
      'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
      'z-index:500',
      'overflow:hidden',
    ].join(';');

    SUPPORTED.forEach(function (lang) {
      const meta = LANG_META[lang];
      const item = document.createElement('button');
      item.className = 'i18n-option';
      item.setAttribute('data-lang', lang);
      item.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'width:100%',
        'padding:8px 14px',
        'background:none',
        'border:none',
        'cursor:pointer',
        'font-size:0.82rem',
        'color:var(--color-text)',
        'text-align:left',
        'transition:background 0.15s',
      ].join(';');
      item.innerHTML = '<span style="font-size:1rem;">' + meta.flag + '</span><span>' + meta.name + '</span>';
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--color-bg)';
      });
      item.addEventListener('mouseleave', function () {
        item.style.background = 'none';
      });
      item.addEventListener('click', function () {
        setLang(lang);
        _closeDropdown(btn, dropdown);
      });
      dropdown.appendChild(item);
    });

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const isOpen = dropdown.style.display === 'block';
      if (isOpen) {
        _closeDropdown(btn, dropdown);
      } else {
        dropdown.style.display = 'block';
        btn.setAttribute('aria-expanded', 'true');
      }
    });

    document.addEventListener('click', function () {
      _closeDropdown(btn, dropdown);
    });

    wrap.appendChild(btn);
    wrap.appendChild(dropdown);

    _updateSwitcherBtn(btn);
    return wrap;
  }

  function _closeDropdown(btn, dropdown) {
    dropdown.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function _updateSwitcher() {
    const btn = document.getElementById('i18n-btn');
    if (btn) _updateSwitcherBtn(btn);
    // Highlight active option
    document.querySelectorAll('.i18n-option').forEach(function (el) {
      const isActive = el.getAttribute('data-lang') === _lang;
      el.style.fontWeight = isActive ? '700' : '400';
      el.style.color = isActive ? 'var(--color-accent)' : 'var(--color-text)';
    });
  }

  function _updateSwitcherBtn(btn) {
    const meta = LANG_META[_lang] || LANG_META.en;
    btn.innerHTML = meta.flag + ' <span style="font-weight:600;">' + meta.label + '</span>'
      + ' <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  }

  /** Mount the language switcher into a target element. */
  function mountSwitcher(targetEl) {
    if (!targetEl) return;
    const sw = createSwitcher();
    targetEl.insertBefore(sw, targetEl.firstChild);
    _updateSwitcher();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    // Restore saved language
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) _lang = saved;
    } catch (_) {}

    document.documentElement.lang = _lang;

    // Mount switcher when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _mountAndApply);
    } else {
      _mountAndApply();
    }
  }

  function _mountAndApply() {
    const headerActions = document.querySelector('.header-actions');
    if (headerActions) mountSwitcher(headerActions);
    apply();
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  window.i18n = { t: t, setLang: setLang, getLang: getLang, apply: apply };

  init();
}(window));
