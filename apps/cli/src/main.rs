use clap::{Parser, Subcommand};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use storagescope_core::{fixtures, scanner::Scanner, stats, ScanConfig};

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
    }
}
