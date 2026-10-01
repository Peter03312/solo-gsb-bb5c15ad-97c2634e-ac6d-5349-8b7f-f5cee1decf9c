'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function initDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });

  const db = new Database(path.join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id            TEXT PRIMARY KEY,
      filename      TEXT NOT NULL,           -- 原始文件名
      stored_name   TEXT NOT NULL,           -- images/ 下的存储文件名
      mime          TEXT NOT NULL,
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,  -- 草稿版本，每次修改 +1
      calib         TEXT,                    -- JSON: {p1:{x,y}, p2:{x,y}, distanceUm, scale}
      cells         TEXT NOT NULL DEFAULT '[]', -- JSON: [{id,name,outer,holes,areaUm2,perimeterUm}]
      fields        TEXT NOT NULL DEFAULT '[]', -- JSON: [{id,name,outer,holes}] 取样视野（密度统计）
      published     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id            TEXT PRIMARY KEY,
      image_id      TEXT NOT NULL,
      draft_version INTEGER NOT NULL,        -- 发布时携带的草稿版本
      title         TEXT NOT NULL,
      filename      TEXT NOT NULL,           -- 原始图片文件名（快照信息）
      snapshot_name TEXT NOT NULL,           -- snapshots/ 下的图片文件名
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      calib         TEXT NOT NULL,
      cells         TEXT NOT NULL,
      fields        TEXT NOT NULL DEFAULT '[]', -- 发布时冻结的取样视野
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comparisons (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      baseline_report_id TEXT NOT NULL,      -- 基线报告
      retest_report_id  TEXT NOT NULL,       -- 复测报告（必须与基线不同）
      pairs             TEXT NOT NULL DEFAULT '[]', -- JSON: [{baselineCellKey, retestCellKey}]，手动一对一
      version           INTEGER NOT NULL DEFAULT 1, -- 比较记录版本，修改时乐观并发
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (baseline_report_id) REFERENCES reports(id) ON DELETE CASCADE,
      FOREIGN KEY (retest_report_id) REFERENCES reports(id) ON DELETE CASCADE
    );
  `);

  // 旧版本数据库的幂等升级：缺少 fields 列时补上（旧报告缺少视野按空列表读取）
  const ensureColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  };
  ensureColumn('images', 'fields', `ALTER TABLE images ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`);
  ensureColumn('reports', 'fields', `ALTER TABLE reports ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`);

  return db;
}

module.exports = { initDb };
