//! 合成目录生成器：生成结构、名称与大小完全确定的测试数据集，
//! 用于黄金测试与性能基准。所有大小均为确定值，可逐字节核对。

use std::fs;
use std::io;
use std::path::Path;

/// 生成结果的期望值清单，供测试直接比对。
#[derive(Debug, Clone)]
pub struct FixtureSummary {
    pub file_count: u64,
    pub dir_count: u64,
    pub total_bytes: u64,
}

fn write_file(path: &Path, size: usize) -> io::Result<()> {
    // 内容按确定模式填充，大小即全部语义。
    let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
    fs::write(path, data)
}

fn create_dir(path: &Path, s: &mut FixtureSummary) -> io::Result<()> {
    fs::create_dir_all(path)?;
    s.dir_count += 1;
    Ok(())
}

fn add_file(path: &Path, size: usize, s: &mut FixtureSummary) -> io::Result<()> {
    write_file(path, size)?;
    s.file_count += 1;
    s.total_bytes += size as u64;
    Ok(())
}

/// 生成标准合成数据集：
/// - 单文件目录、空目录
/// - 10 层深目录（每层文件大小 = 层深 × 10 字节）
/// - 宽目录：20 个子目录 × 5 个 32 字节文件
/// - 中文、空格、emoji 路径
pub fn generate(root: &Path) -> io::Result<FixtureSummary> {
    let mut s = FixtureSummary {
        file_count: 0,
        dir_count: 0,
        total_bytes: 0,
    };

    create_dir(root, &mut s)?;

    // 单文件
    let d = root.join("单文件目录");
    create_dir(&d, &mut s)?;
    add_file(&d.join("one.txt"), 5, &mut s)?;

    // 空目录（不产生文件，但必须被计为目录）
    create_dir(&root.join("空目录"), &mut s)?;

    // 深目录：depth01/.../depth10，每层一个文件
    let mut cur = root.to_path_buf();
    for depth in 1..=10usize {
        cur = cur.join(format!("深{depth:02}"));
        create_dir(&cur, &mut s)?;
        add_file(&cur.join(format!("f{depth:02}.dat")), depth * 10, &mut s)?;
    }

    // 宽目录
    let wide = root.join("宽目录");
    create_dir(&wide, &mut s)?;
    for d in 0..20 {
        let sub = wide.join(format!("d{d:02}"));
        create_dir(&sub, &mut s)?;
        for f in 0..5 {
            add_file(&sub.join(format!("f{f}.bin")), 32, &mut s)?;
        }
    }

    // 中文、空格、emoji 名称
    let zh = root.join("中文目录 带空格");
    create_dir(&zh, &mut s)?;
    add_file(&zh.join("数据 文件.txt"), 100, &mut s)?;
    let emoji = root.join("emoji 🎮");
    create_dir(&emoji, &mut s)?;
    add_file(&emoji.join("存档 💾.dat"), 77, &mut s)?;

    // 大小写相似名称（Windows 下不区分大小写，两个文件分开放）
    let case_dir = root.join("CaseTest");
    create_dir(&case_dir, &mut s)?;
    add_file(&case_dir.join("Report.TXT"), 11, &mut s)?;
    add_file(&case_dir.join("report2.txt"), 13, &mut s)?;

    Ok(s)
}

/// 生成大型基准数据集：`dirs` 个子目录，每个 `files_per_dir` 个文件，
/// 文件大小按确定公式分布。用于性能基准，不用于黄金正确性。
pub fn generate_large(
    root: &Path,
    dirs: usize,
    files_per_dir: usize,
) -> io::Result<FixtureSummary> {
    let mut s = FixtureSummary {
        file_count: 0,
        dir_count: 0,
        total_bytes: 0,
    };
    create_dir(root, &mut s)?;
    for d in 0..dirs {
        let sub = root.join(format!("bench{d:04}"));
        create_dir(&sub, &mut s)?;
        for f in 0..files_per_dir {
            let size = (d * 7 + f * 13) % 4096 + 16;
            add_file(&sub.join(format!("f{f:04}.dat")), size, &mut s)?;
        }
    }
    Ok(s)
}
