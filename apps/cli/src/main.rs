use clap::{Parser, Subcommand};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use storagescope_core::{diff as ssdiff, fixtures, scanner::Scanner, snapshot, stats, ScanConfig};

#[derive(Parser)]
#[command(name = "ss", about = "StorageScope 命令行原型（M1）", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 只读扫描目录并输出聚合统计
    Scan {
        path: PathBuf,
        /// 以 JSON 输出完整统计树
        #[arg(long)]
        json: bool,
        /// 扫描 N 个文件后自动取消（用于演示/测试取消链路）
        #[arg(long)]
        cancel_after: Option<u64>,
    },
    /// 生成标准合成测试数据集
    GenFixtures { path: PathBuf },
    /// 生成大型基准数据集：--dirs 个子目录 × --files 个文件
    GenBench {
        path: PathBuf,
        #[arg(long, default_value_t = 100)]
        dirs: usize,
        #[arg(long, default_value_t = 500)]
        files: usize,
    },
    /// 诊断探针：纯 std 串行遍历，报告每个目录的条目数
    Probe { path: PathBuf },
    /// 快照管理
    Snap {
        #[command(subcommand)]
        cmd: SnapCmd,
    },
    /// 比较两个同根目录快照
    Diff {
        #[arg(long)]
        db: PathBuf,
        old: i64,
        new: i64,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum SnapCmd {
    /// 扫描目录并保存为快照（被取消的结果拒绝入库）
    Save { path: PathBuf, #[arg(long)] db: PathBuf },
    /// 列出全部快照
    List { #[arg(long)] db: PathBuf },
}

fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[i])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

fn print_tree(stat: &storagescope_core::model::DirStat, depth: usize, max_depth: usize) {
    let indent = "  ".repeat(depth);
    let warn = if stat.has_errors { "  ⚠ 统计可能不完整" } else { "" };
    println!(
        "{}{:>12}  {:>6} 文件  {}{}",
        indent,
        human_size(stat.total_size),
        stat.file_count,
        stat.name,
        warn
    );
    if depth < max_depth {
        for c in &stat.children {
            print_tree(c, depth + 1, max_depth);
        }
    }
}

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::GenFixtures { path } => {
            let s = fixtures::generate(&path).expect("生成合成数据集失败");
            println!(
                "已生成标准数据集：{} → {} 个文件，{} 个目录，{}",
                path.display(),
                s.file_count,
                s.dir_count,
                human_size(s.total_bytes)
            );
        }
        Cmd::GenBench { path, dirs, files } => {
            let s = fixtures::generate_large(&path, dirs, files).expect("生成基准数据集失败");
            println!(
                "已生成基准数据集：{} → {} 个文件，{} 个目录，{}",
                path.display(),
                s.file_count,
                s.dir_count,
                human_size(s.total_bytes)
            );
        }
        Cmd::Scan {
            path,
            json,
            cancel_after,
        } => {
            let scanner = Scanner::new(ScanConfig {
                progress_every: 5000,
                ..Default::default()
            });

            // Ctrl+C 协作式取消：不产生损坏输出，明确标记不完整
            let cancel = scanner.cancel_handle();
            ctrlc::set_handler(move || {
                cancel.store(true, Ordering::Relaxed);
            })
            .expect("注册 Ctrl+C 处理器失败");

            let demo_cancel = scanner.cancel_handle();
            let outcome = scanner.scan(&path, move |p, cur| {
                if let Some(n) = cancel_after {
                    if p.files >= n {
                        demo_cancel.store(true, Ordering::Relaxed);
                    }
                }
                let _ = writeln!(
                    std::io::stderr(),
                    "… 已扫描 {} 个文件，{}，当前：{}",
                    p.files,
                    human_size(p.bytes),
                    cur.display()
                );
            });

            if json {
                let tree = stats::aggregate(&outcome);
                let report = serde_json::json!({
                    "root": outcome.root,
                    "complete": outcome.is_complete(),
                    "cancelled": outcome.cancelled,
                    "duration_ms": outcome.duration_ms,
                    "file_count": outcome.file_count(),
                    "total_bytes": outcome.total_bytes(),
                    "errors": outcome.errors,
                    "tree": tree,
                });
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
            } else {
                let tree = stats::aggregate(&outcome);
                print_tree(&tree, 0, 2);
                println!();
                println!(
                    "合计：{} 个文件，{} 个目录，{}；耗时 {} ms",
                    outcome.file_count(),
                    outcome.dirs.len(),
                    human_size(outcome.total_bytes()),
                    outcome.duration_ms
                );
                if outcome.cancelled {
                    println!("状态：已被取消 —— 结果不完整，不得保存为快照");
                }
                if !outcome.errors.is_empty() {
                    println!("异常：{} 条（统计可能不完整）", outcome.errors.len());
                    for e in outcome.errors.iter().take(10) {
                        println!("  - [{:?}] {}：{}", e.category, e.path, e.message);
                    }
                }
            }
        }
        Cmd::Probe { path } => {
            // 纯 std 迭代式遍历探针：定位 jwalk 空转的确切位置
            let mut stack = vec![path];
            let mut dirs = 0u64;
            let mut files = 0u64;
            let started = std::time::Instant::now();
            while let Some(d) = stack.pop() {
                match std::fs::read_dir(&d) {
                    Ok(rd) => {
                        let mut count = 0u64;
                        for e in rd {
                            let e = match e {
                                Ok(x) => x,
                                Err(err) => {
                                    println!("ERR {}：{}", d.display(), err);
                                    continue;
                                }
                            };
                            count += 1;
                            match e.file_type() {
                                Ok(ft) if ft.is_symlink() => {
                                    println!("LINK {}", e.path().display());
                                }
                                Ok(ft) if ft.is_dir() => stack.push(e.path()),
                                Ok(_) => files += 1,
                                Err(err) => println!("ERR-FT {}：{}", e.path().display(), err),
                            }
                        }
                        dirs += 1;
                        if count > 5000 {
                            println!("BIGDIR {} 个条目：{}", count, d.display());
                        }
                        if dirs % 2000 == 0 {
                            eprintln!(
                                "… dirs={} files={} 待处理={} 耗时{:?}",
                                dirs,
                                files,
                                stack.len(),
                                started.elapsed()
                            );
                        }
                    }
                    Err(e) => println!("ERRDIR {}：{}", d.display(), e),
                }
            }
            println!("完成：{} 目录，{} 文件，耗时 {:?}", dirs, files, started.elapsed());
        }
        Cmd::Snap { cmd } => match cmd {            SnapCmd::Save { path, db } => {
                let scanner = Scanner::new(ScanConfig::default());
                let cancel = scanner.cancel_handle();
                ctrlc::set_handler(move || {
                    cancel.store(true, Ordering::Relaxed);
                })
                .expect("注册 Ctrl+C 处理器失败");
                let outcome = scanner.scan(&path, |_, _| {});
                if outcome.cancelled {
                    eprintln!("已取消：快照未保存。取消的结果不完整，不得入库。");
                    std::process::exit(1);
                }
                let conn = snapshot::open(&db).expect("打开快照数据库失败");
                match snapshot::save(&conn, &outcome).expect("保存快照失败") {
                    Some(id) => println!(
                        "快照 #{id} 已保存：{} 个文件，{}，{}；状态 {}",
                        outcome.file_count(),
                        human_size(outcome.total_bytes()),
                        db.display(),
                        if outcome.errors.is_empty() {
                            "完整"
                        } else {
                            "不完整（存在扫描异常）"
                        }
                    ),
                    None => {
                        eprintln!("快照未保存。");
                        std::process::exit(1);
                    }
                }
            }
            SnapCmd::List { db } => {
                let conn = snapshot::open(&db).expect("打开快照数据库失败");
                let snaps = snapshot::list(&conn).expect("读取快照列表失败");
                if snaps.is_empty() {
                    println!("（没有快照）");
                }
                for s in snaps {
                    println!(
                        "#{:<3} {}  {} 个文件  {}  [{}]",
                        s.id,
                        s.root,
                        s.file_count,
                        human_size(s.total_bytes as u64),
                        s.status
                    );
                }
            }
        },
        Cmd::Diff { db, old, new, json } => {
            let conn = snapshot::open(&db).expect("打开快照数据库失败");
            let report = match ssdiff::diff(&conn, old, new) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("无法比较：{e}");
                    std::process::exit(2);
                }
            };
            if json {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
            } else {
                for w in &report.warnings {
                    println!("⚠ {w}");
                }
                println!(
                    "快照 #{old} → #{new}：新增 {} 文件（+{}），删除 {} 文件（-{}），增长 {}，缩减 {}；净变化 {}",
                    report.summary.added_files,
                    human_size(report.summary.added_bytes),
                    report.summary.removed_files,
                    human_size(report.summary.removed_bytes),
                    report.summary.grown_files,
                    report.summary.shrunk_files,
                    report.summary.net_bytes
                );
                println!("\n变化最大的目录：");
                for d in report.dirs.iter().take(10) {
                    println!(
                        "  {:>12}  {}（{} 个文件变化）",
                        d.net_bytes, d.rel_path, d.changed_files
                    );
                }
                println!("\n变化最大的文件：");
                for c in report.files.iter().take(10) {
                    let kind = match c.kind {
                        ssdiff::ChangeKind::Added => "新增",
                        ssdiff::ChangeKind::Removed => "删除",
                        ssdiff::ChangeKind::Grown => "增长",
                        ssdiff::ChangeKind::Shrunk => "缩减",
                    };
                    println!(
                        "  [{}] {}（{} → {}）",
                        kind,
                        c.rel_path,
                        c.old_size.map(|v| v.to_string()).unwrap_or("—".into()),
                        c.new_size.map(|v| v.to_string()).unwrap_or("—".into())
                    );
                }
            }
        }
    }
}
