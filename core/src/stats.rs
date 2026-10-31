use crate::model::*;
use crate::scanner::parent_of;
use std::collections::HashMap;

/// 由文件节点自底向上聚合目录统计。
/// 目录大小 = 本次成功扫描到的所有后代文件的逻辑大小之和。
pub fn aggregate(outcome: &ScanOutcome) -> DirStat {
    // 1. 建立目录集合：扫描到的目录 + 文件路径隐含的所有祖先目录。
    let mut dir_set: HashMap<String, String> = HashMap::new(); // rel_path -> name
    for d in &outcome.dirs {
        // 根目录条目（rel_path 为 "."）由树构建逻辑单独处理，不进入集合，
        // 否则 parent_of(".") == "." 会造成自引用递归。
        if d.rel_path != "." {
            dir_set.insert(d.rel_path.clone(), d.name.clone());
        }
    }
    for f in &outcome.files {
        let mut p = parent_of(&f.rel_path).to_string();
        while p != "." {
            if !dir_set.contains_key(&p) {
                let name = p.rsplit('/').next().unwrap_or(&p).to_string();
                dir_set.insert(p.clone(), name);
            }
            p = parent_of(&p).to_string();
        }
    }

    // 2. 初始化每个目录的自身统计（仅直接文件）。
    let mut own_size: HashMap<String, u64> = HashMap::new();
    let mut own_files: HashMap<String, u64> = HashMap::new();
    for f in &outcome.files {
        let parent = parent_of(&f.rel_path).to_string();
        *own_size.entry(parent.clone()).or_insert(0) += f.size;
        *own_files.entry(parent).or_insert(0) += 1;
    }

    // 3. 错误路径归一化为相对路径，便于判断某目录是否受影响。
    let root_display = &outcome.root;
    let rel_errors: Vec<String> = outcome
        .errors
        .iter()
        .map(|e| {
            std::path::Path::new(&e.path)
                .strip_prefix(root_display)
                .map(|r| {
                    r.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or_else(|_| e.path.clone())
        })
        .collect();

    // 4. 自底向上聚合：按深度倒序处理，把子目录累计进父目录。
    let mut total_size: HashMap<String, u64> = own_size.clone();
    let mut total_files: HashMap<String, u64> = own_files.clone();

    let mut dirs_by_depth: Vec<&String> = dir_set.keys().collect();
    dirs_by_depth.sort_by_key(|p| std::cmp::Reverse(p.matches('/').count()));
    for d in dirs_by_depth {
        let parent = parent_of(d).to_string();
        let s = *total_size.get(d).unwrap_or(&0);
        let c = *total_files.get(d).unwrap_or(&0);
        *total_size.entry(parent.clone()).or_insert(0) += s;
        *total_files.entry(parent).or_insert(0) += c;
    }

    // 5. 递归构建 DirStat 树。
    fn build(
        rel: &str,
        name: &str,
        dir_set: &HashMap<String, String>,
        total_size: &HashMap<String, u64>,
        total_files: &HashMap<String, u64>,
        rel_errors: &[String],
    ) -> DirStat {
        let mut children: Vec<DirStat> = dir_set
            .iter()
            .filter(|(p, _)| parent_of(p) == rel)
            .map(|(p, n)| build(p, n, dir_set, total_size, total_files, rel_errors))
            .collect();
        children.sort_by(|a, b| b.total_size.cmp(&a.total_size).then(a.name.cmp(&b.name)));

        let prefix = if rel == "." {
            String::new()
        } else {
            format!("{rel}/")
        };
        let has_errors = rel_errors
            .iter()
            .any(|e| e == rel || (!prefix.is_empty() && e.starts_with(&prefix)));

        DirStat {
            rel_path: rel.to_string(),
            name: name.to_string(),
            total_size: *total_size.get(rel).unwrap_or(&0),
            file_count: *total_files.get(rel).unwrap_or(&0),
            subdir_count: children.len() as u64,
            has_errors,
            children,
        }
    }

    let root_name = std::path::Path::new(&outcome.root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| outcome.root.clone());

    build(
        ".",
        &root_name,
        &dir_set,
        &total_size,
        &total_files,
        &rel_errors,
    )
}
