# OH2P 1.62.2 补丁审查

## 审查对象

- 固件：`mico_all_616cd9d93_1.62.2`
- 型号：`OH2P`
- ROM：`1.62.2`
- 固件构建时间：2026-04-17
- 补丁：`patches/01-ssh.patch` 至 `patches/04-start.patch`

## 结论

OH2P 1.62.2 的补丁目标文件、认证配置和升级调用路径与现有补丁兼容。没有发现因该固件版本变化而必须修改补丁的情况；SSH、root 密码认证和自定义启动脚本链路均自洽。

`03-ota.patch` 会有意禁用所有设备内升级路径，而不只是定时自动 OTA。是否移除其中对 `bin/flash.sh` 的拦截，取决于是否要保留设备内手动升级能力。

本结论来自对已提取 rootfs 的静态审查；未在设备上刷写或执行补丁流程。

## 补丁逐项分析

### 01-ssh.patch

新版 `/etc/config/dropbear` 已启用以下配置：

```text
PasswordAuth=1
RootPasswordAuth=1
Port=22
```

补丁移除了小米对 SSH 的额外开关、release 渠道限制和蓝牙模式限制，使 Dropbear 在默认配置下启动。新版 Dropbear 仍依赖 PAM，并使用 `sshd` PAM 服务；`/etc/pam.d/sshd` 引入 `common-auth`，与 `02-login.patch` 的认证改动匹配。

结论：不会导致 SSH 登录链路失效。

副作用：

- 蓝牙工作模式也会尝试启动 SSH。
- `/etc/config/dropbear` 损坏时，补丁会忽略配置校验失败并继续启动；正常配置下无影响。
- SSH 暴露面较原厂扩大。

### 02-login.patch

固件当前 root 密码使用 `$1$...` MD5-crypt 格式。补丁脚本使用：

```sh
openssl passwd -1
```

生成相同格式的哈希，`pam_unix.so` 可验证该格式。

修改后的 PAM 链路为：

```text
pam_unix 成功 → 跳过 pam_deny → pam_permit 成功
pam_unix 失败 → pam_deny 拒绝
```

因此 root 的 SSH 密码认证可以正常工作。

副作用：

- `ttyS0` 从 `/bin/login` 改为 `/bin/ash --login`；物理串口直接获得 root shell，不再要求密码。
- `libmico-pam.so` 被禁用。未单独配置 PAM policy 的本地认证程序会由小米认证逻辑转为 Unix 密码认证。

### 03-ota.patch

该补丁截断三条设备内升级路径：

1. 定时自动 OTA：root crontab 每天执行 `/bin/ota slient`；补丁使 `download_upgrade()` 和 `upgrade()` 直接失败。
2. 网络/应用下发更新：`/etc/init.d/wireless` 的 `ota()` 在下载和写入前直接返回 `download_fail`。
3. 设备内手动升级：`/bin/flash.sh` 的 `upgrade_param_check()` 直接失败，因此无法在设备上手动执行 `flash.sh firmware.bin`。

前两项是防止原厂 OTA 覆盖补丁的必要行为。第三项会同时禁用手动升级和设备内恢复通道。

建议：

- 接受后续必须离线刷入原厂或新补丁固件：保留该补丁原样。
- 只想阻止自动/网络 OTA，同时保留设备内手动刷写：删除 `03-ota.patch` 中针对 `bin/flash.sh` 的 hunk，即删除以下两行：

  ```diff
  +	klogger "no upgrade"
  +	return 1
  ```

  现有固件中已找到的内部 `flash.sh` 调用均位于已被前两处拦截的 OTA 路径之后，因此删除该 hunk 可保留手动调用能力，而不恢复定时 OTA 和网络下发 OTA。

### 04-start.patch

`/data/init.sh` 不存在时没有任何额外启动动作。其启动位置是 post-boot 的 `done` 服务；补丁将它放入后台执行，随后固件仍会执行：

```sh
/etc/init.d/wireless boot_done
```

结论：不会影响默认启动。

副作用：

- 自定义 `/data/init.sh` 若依赖 Wi-Fi、MiIO 或播放器已就绪，应自行等待相应服务。
- 脚本标准输出和错误输出均被丢弃，失败不会显示在控制台。

## 最终建议

- 为 OH2P 1.62.2 制作 SSH 补丁固件：现有补丁可直接使用。
- 需要保留设备内手动升级能力：仅调整 `03-ota.patch` 的 `bin/flash.sh` hunk。
- 刷入后应至少验证：设备正常启动、局域网 SSH 密码登录、音频播放与联网、以及自定义 `/data/init.sh`（若使用）。
