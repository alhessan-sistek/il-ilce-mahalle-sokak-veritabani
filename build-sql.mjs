// build-sql.mjs — data/ JSONL verilerini SQL dosyasına dönüştürür
//
// node build-sql.mjs --db=mysql --case=upper --out=sql/uppercase_data.sql
// node build-sql.mjs --db=psql  --case=title --out=sql/titlecase_psql.sql
//
// --db     mysql | psql
// --case   upper | title
// --out    dosya yolu (verilmezse stdout)

import fs from 'fs';
import path from 'path';

const DATA_DIR = 'data';

const args = {};
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
}

const db      = args.db   || 'mysql';
const kase    = args.case || 'upper';
const outFile = args.out;

if (!['mysql', 'psql', 'mssql'].includes(db))    { log('Hata: --db=mysql|psql|mssql');    process.exit(1); }
if (!['upper', 'title'].includes(kase)) { log('Hata: --case=upper|title'); process.exit(1); }

// toLocaleLowerCase('tr-TR') kullanmak şart, yoksa İ/I/ı/i dönüşümleri bozuluyor
function titleTR(str) {
    if (!str) return str;
    return str
        .toLocaleLowerCase('tr-TR')
        .replace(/(^|[\s.\/(])(\p{L})/gu, (_, pre, ch) =>
            pre + ch.toLocaleUpperCase('tr-TR')
        );
}

function applyCase(str) {
    return kase === 'title' ? titleTR(str) : str;
}

const Q = db === 'mysql' ? '`' : db === 'mssql' ? '[' : '"';
const q = n => {
    if (db === 'mssql' && n.includes('.')) {
        return n.split('.').map(p => Q + p + (db === 'mssql' ? ']' : Q)).join('.');
    }
    return Q + n + (db === 'mssql' ? ']' : Q);
};

function val(v) {
    if (v == null) return 'NULL';
    if (typeof v === 'number') return String(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
}

function createTable(name, cols, pk) {
    const fullName = db === 'mssql' ? `geo.${name}` : name;
    w(`DROP TABLE IF EXISTS ${q(fullName)};`);
    w(`CREATE TABLE ${q(fullName)} (`);
    const defs = cols.map(([c, mType, pType, mssqlType]) =>
        `  ${q(c)} ${db === 'mysql' ? mType : db === 'psql' ? pType : mssqlType}`
    );
    defs.push(`  PRIMARY KEY (${pk.map(q).join(', ')})`);
    w(defs.join(',\n'));
    w(db === 'mysql'
        ? ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;'
        : ');'
    );
    w();
}

function ins(table, cols, vals) {
    const fullTable = db === 'mssql' ? `geo.${table}` : table;
    w(`INSERT INTO ${q(fullTable)} (${cols.map(q).join(', ')}) VALUES (${vals.join(', ')});`);
}

function readJsonl(file) {
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function countLines(file) {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
}

function log(msg) { process.stderr.write(msg + '\n'); }

const out = outFile
    ? fs.createWriteStream(outFile, { encoding: 'utf-8' })
    : process.stdout;

const _buf = [];
function w(line = '') { _buf.push(line); if (_buf.length >= 2000) flush(); }
function flush() { if (_buf.length) { out.write(_buf.join('\n') + '\n'); _buf.length = 0; } }

log(`Hedef: ${db} | Harf: ${kase}`);
log('Veriler okunuyor...');

const iller = readJsonl(path.join(DATA_DIR, 'iller.jsonl'))
    .sort((a, b) => a.kimlikNo - b.kimlikNo);

const ilceler = [];
let totalMah = 0, totalSok = 0;

for (const il of iller) {
    const dir = path.join(DATA_DIR, `il-${il.kimlikNo}`);
    ilceler.push(...readJsonl(path.join(dir, 'ilceler.jsonl')));
    totalMah += countLines(path.join(dir, 'mahalleler.jsonl'));
    totalSok += countLines(path.join(dir, 'sokaklar.jsonl'));
}
ilceler.sort((a, b) => a.kimlikNo - b.kimlikNo);

log(`İl: ${iller.length} | İlçe: ${ilceler.length} | Mahalle: ${totalMah} | Sokak: ${totalSok}`);

// header
const caseLabel = kase === 'upper' ? 'BÜYÜK HARF' : 'Title Case';
w(`-- Türkiye Adres Veritabanı (${caseLabel})`);
w(`-- Oluşturma: ${new Date().toLocaleDateString('tr-TR')}`);
w(`-- Kaynak: adres.nvi.gov.tr`);
w(`-- İl: ${iller.length} | İlçe: ${ilceler.length} | Mahalle: ${totalMah} | Sokak: ${totalSok}`);
w();

if (db === 'mysql') {
    w('SET NAMES utf8mb4;');
    w('SET FOREIGN_KEY_CHECKS = 0;');
    w();
} else if (db === 'mssql') {
    w('CREATE SCHEMA geo;');
    w();
}

// provinces

createTable('provinces', [
    ['id',    'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['name',  'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['plate_code', 'int(11) DEFAULT NULL',      'integer', 'int'],
], ['id']);

w('BEGIN;');
for (const il of iller) {
    ins('provinces', ['id', 'name', 'plate_code'], [
        il.kimlikNo, val(applyCase(il.adi)), il.kimlikNo,
    ]);
}
w('COMMIT;');
w();

// districts

createTable('districts', [
    ['id',       'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['name',     'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['identity_number', 'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['province_id',    'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
], ['id', 'identity_number', 'province_id']);

w('BEGIN;');
for (const r of ilceler) {
    ins('districts', ['id', 'name', 'identity_number', 'province_id'], [
        r.kimlikNo, val(applyCase(r.adi)), r.kimlikNo, r.il_id,
    ]);
}
w('COMMIT;');
w();

// neighborhoods

createTable('neighborhoods', [
    ['id',          'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['name',        'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['full_name', 'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['identity_number',    'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['province_id',       'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['district_id',     'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
], ['id', 'identity_number', 'province_id', 'district_id']);

log('Neighborhoods writing...');
w('BEGIN;');
let mCount = 0;
for (const il of iller) {
    const rows = readJsonl(path.join(DATA_DIR, `il-${il.kimlikNo}`, 'mahalleler.jsonl'))
        .sort((a, b) => a.kimlikNo - b.kimlikNo);
    for (const r of rows) {
        ins('neighborhoods', ['id', 'name', 'full_name', 'identity_number', 'province_id', 'district_id'], [
            r.kimlikNo, val(applyCase(r.adi)), val(applyCase(r.bilesenAdi)),
            r.kimlikNo, r.il_id, r.ilce_id,
        ]);
    }
    mCount += rows.length;
}
w('COMMIT;');
w();
log(`  ${mCount.toLocaleString('tr-TR')} neighborhoods written.`);

// streets

createTable('streets', [
    ['id',          'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['name',        'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['full_name', 'varchar(255) DEFAULT NULL', 'text', 'nvarchar(255)'],
    ['province_id',       'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['district_id',     'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
    ['neighborhood_id',  'int(11) NOT NULL',          'integer NOT NULL', 'int NOT NULL'],
], ['id', 'province_id', 'district_id', 'neighborhood_id']);

log('Streets writing...');
w('BEGIN;');
let sCount = 0;
for (const il of iller) {
    const rows = readJsonl(path.join(DATA_DIR, `il-${il.kimlikNo}`, 'sokaklar.jsonl'))
        .sort((a, b) => a.kimlikNo - b.kimlikNo);
    for (const r of rows) {
        ins('streets', ['id', 'name', 'full_name', 'province_id', 'district_id', 'neighborhood_id'], [
            r.kimlikNo, val(applyCase(r.adi)), val(applyCase(r.bilesenAdi)),
            r.il_id, r.ilce_id, r.mahalle_id,
        ]);
    }
    sCount += rows.length;
}
w('COMMIT;');
w();
log(`  ${sCount.toLocaleString('tr-TR')} streets written.`);

if (db === 'mysql') {
    w('SET FOREIGN_KEY_CHECKS = 1;');
}

flush();

if (outFile) {
    out.end(() => log(`Tamamlandı: ${outFile}`));
} else {
    log('Tamamlandı.');
}
