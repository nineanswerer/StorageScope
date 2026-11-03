# Windows 代码签名流程

当前 Beta 没有可用的代码签名证书，因此实际 Authenticode 签署处于外部阻塞状态。以下流程在取得证书后执行。

## 准备

- 使用受信任证书颁发机构签发的代码签名证书，并把证书及私钥安装到签名机器的证书存储区。
- 安装 Windows SDK 中的 `signtool.exe`。
- 确认证书主题名称，使用 `scripts/sign-artifact.ps1` 时通过 `-CertificateSubject` 指定。
- 私钥、证书密码和任何更新私钥不得提交仓库或写入日志。

自签名证书可用于内部链路试验，但不能作为公开发布的受信任签名。

## 签署单个产物

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-artifact.ps1 `
  -Path "apps/desktop/src-tauri/target/release/bundle/nsis/StorageScope_0.3.0-beta.2_x64-setup.exe" `
  -CertificateSubject "替换为证书主题"
```

脚本使用 SHA-256 文件摘要、RFC 3161 时间戳，并调用 `signtool verify /pa /v` 验证。主程序、卸载程序和安装包需要分别纳入签名流程；只签安装包不等于内部程序也已签名。

## 发布前检查

1. 对需要分发的每个 PE 文件运行签名脚本。
2. 在另一台未导入私有签名材料的 Windows 机器上验证发布者链和文件哈希。
3. 确认签名后的文件名、字节数和 SHA-256 已重新写入 Release 说明。
4. 记录证书有效期与时间戳验证结果，不公开证书密码或私钥。

如果要把签名嵌入 Tauri 构建和卸载程序生成过程，应在证书可用后单独配置并验收 `bundle.windows.signCommand`，避免当前无证书环境的构建被强制阻塞。
