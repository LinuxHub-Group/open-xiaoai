# 关闭蓝牙连接/断开提示音

本文说明如何关闭小爱音箱在蓝牙连接、断开时播放的：

- `蓝牙已连接`
- `蓝牙已断开`

适用固件：`OH2P` / `LX06` 的 `root-patched.squashfs`，以及同结构的其他小米音箱固件。

---

## 1. 结论

提示音来自两个 Opus 文件：

```text
/usr/share/sound/bluetooth_connect.opus
/usr/share/sound/bluetooth_disconnect.opus
```

`mibt` 在蓝牙事件发生时直接调用 `qplayer` 播放这两个文件，不读取 `/etc/tts/tts_normal.conf` 里的中文文本。

因此有三种关闭方式：

| 方式 | 是否需要重刷 | 是否保留音频文件 | 适用场景 |
|---|---|---|---|
| 删除/重命名 Opus 文件 | 重打包时需要 | 否 | 最简单、最推荐 |
| 设备上把 `/data/sound` 改为可写目录 | 不需要 | 否 | 已刷机，临时关闭 |
| 修改 `mibt` 跳过播放调用 | 重打包时需要 | 是 | 想保留文件，只关提示音 |

---

## 2. 提示音触发链

### 2.1 连接提示音

BlueZ 暴露 `org.bluez.MediaTransport1` 后，`mibt` 在 `0x17B90` 附近把 `[state+0x14]` 置 1 并记录连接时间，在 `0x17C54` 附近启动 1500ms 定时器。定时器回调在 `0x17DA8`：

- 如果 1500ms 后仍然处于连接状态，执行：

```sh
ubus -t 1 call qplayer play '{"play":"/usr/share/sound/bluetooth_connect.opus"}' &
```

- 如果期间已经断开，则不播放。

### 2.2 断开提示音

BlueZ 发出 `org.freedesktop.DBus.Properties.PropertiesChanged`，接口为 `org.bluez.Device1`，属性 `Connected=false`。`mibt` 的 `0x18634` 处理断开：

- 如果当前状态不是已连接，直接返回，不播放。
- 如果连接时长 >= 1000ms，立即执行：

```sh
ubus -t 1 call qplayer play '{"play":"/usr/share/sound/bluetooth_disconnect.opus"}' &
```

- 如果连接时长 < 1000ms，启动线程 `0x175CC`，先 `sleep(2)`，再次检查：
  - 仍处于断开状态才播放；
  - 如果已经重连，则不播放。

### 2.3 为什么改 `tts_normal.conf` 没用

`/etc/tts/tts_normal.conf` 里虽然有：

```text
bluetooth_connect.opus
蓝牙已连接
bluetooth_disconnect.opus
蓝牙已断开
```

但这是文件名到文本的映射表，蓝牙自动事件不经过它。`mibt` 直接拼接 `qplayer` 命令并播放 Opus 文件。

### 2.4 音频文件路径

```text
/usr/share/sound
    -> /data/sound
        -> /usr/share/sound-vendor/<vendor>   # 内置音色，只读 squashfs
           或 /data/sound-vendor/<vendor>     # OTA 下载音色，/data 可写
```

如果目标落在内置音色目录，直接对 `/usr/share/sound/*.opus` 执行 `mv` 或 `rm` 会报：

```text
Read-only file system
```

如果目标落在 `/data/sound-vendor/<vendor>`，则本身可写，可以直接改名或删除。

`<vendor>` 由 `/data/mipns/tts_vendor` 决定，默认是 `AiNiRobot`。可用下面的命令查看：

```sh
readlink -f /data/sound
cat /data/mipns/tts_vendor
```

---

## 3. 方案一：删除或重命名 Opus 文件

### 3.1 重打包 ROM（推荐）

必须在 Linux/WSL 下用 `unsquashfs` 解包。不要用 7z，7z 会丢失符号链接和设备节点。

建议使用 root 或 `sudo` 执行，否则设备节点和文件权限可能无法正确保留。

```sh
# 1. 解包原镜像
sudo unsquashfs -d squashfs-root root-patched.squashfs

# 2. 删除所有音色目录下的两个提示音
cd squashfs-root
for d in usr/share/sound-vendor/*/; do
    rm -f "$d/bluetooth_connect.opus"
    rm -f "$d/bluetooth_disconnect.opus"
done

# 3. 重新打包
cd ..
sudo mksquashfs squashfs-root root-patched-nobtprompt.squashfs \
    -comp xz -b 131072 \
    -noappend -all-root -always-use-fragments -no-xattrs -no-exports
```

只删除当前音色目录也可以，例如：

```sh
rm -f usr/share/sound-vendor/AiNiRobot/bluetooth_connect.opus
rm -f usr/share/sound-vendor/AiNiRobot/bluetooth_disconnect.opus
```

但建议删除所有 `sound-vendor/*/`，避免切换音色后提示音恢复。

如果选择重命名而不是删除：

```sh
mv "$d/bluetooth_connect.opus"    "$d/bluetooth_connect.opus.bak"
mv "$d/bluetooth_disconnect.opus" "$d/bluetooth_disconnect.opus.bak"
```

`.bak` 文件也会占用镜像空间，通常直接删除即可。

### 3.2 设备上运行时关闭（不重刷）

原理：把 `/data/sound` 从“指向只读 squashfs 的符号链接”替换成 `/data` 分区上的真实目录。

`/data` 是持久分区，重启后仍然有效。

```sh
# 如果 /data/sound 还是符号链接，先复制成可写目录
if [ -L /data/sound ]; then
    SRC=$(readlink -f /data/sound)
    V=${SRC##*/}
    # 防止 /data/sound 变成目录后，启动脚本误把音色记成 "sound"
    [ -e /data/mipns/tts_vendor ] || echo -n "$V" > /data/mipns/tts_vendor
    rm /data/sound
    mkdir -p /data/sound
    cp -a "$SRC"/. /data/sound/
elif [ ! -e /data/sound ]; then
    V=$(cat /data/mipns/tts_vendor 2>/dev/null)
    [ -n "$V" ] || V=AiNiRobot
    echo -n "$V" > /data/mipns/tts_vendor
    mkdir -p /data/sound
    cp -a "/usr/share/sound-vendor/$V"/. /data/sound/
fi

# 删除两个提示音
rm -f /data/sound/bluetooth_connect.opus
rm -f /data/sound/bluetooth_disconnect.opus

# 验证
ls -l /data/sound/bluetooth_connect.opus
ls -l /data/sound/bluetooth_disconnect.opus
readlink -f /usr/share/sound
```

期望结果：

- 两个 `ls` 都返回 `No such file or directory`。
- `readlink -f /usr/share/sound` 输出 `/data/sound`。
- `/data/sound` 是普通目录，不再是 `lrwx`。

如果 `/data` 空间紧张，可以不复制全部文件，而是只创建其他音频的符号链接。以下命令只适用于 `/data/sound` 仍是符号链接的情况：

```sh
if [ -L /data/sound ]; then
    SRC=$(readlink -f /data/sound)
    V=${SRC##*/}
    [ -e /data/mipns/tts_vendor ] || echo -n "$V" > /data/mipns/tts_vendor
    rm /data/sound
    mkdir -p /data/sound
    for f in "$SRC"/*; do
        b=${f##*/}
        case "$b" in
            bluetooth_connect.opus|bluetooth_disconnect.opus) continue ;;
        esac
        ln -s "$f" "/data/sound/$b"
    done
else
    echo "/data/sound 不是符号链接，跳过"
fi
```

---

## 4. 方案二：修改 `mibt`，保留音频文件

如果不想删除音频文件，可以只跳过 `mibt` 里的三次 `qplayer` 播放调用。

文件：`usr/bin/mibt`（ARM32，小端）

`.text` 段虚拟地址与文件偏移的差值为 `0x10000`，即：

```text
文件偏移 = 虚拟地址 - 0x10000
```

| 用途 | 虚拟地址 | 文件偏移 | 原始字节 | 修改为 |
|---|---:|---:|---|---|
| 连接提示音 | `0x17DEC` | `0x7DEC` | `41 F5 FF EB` | `00 00 A0 E1` |
| 快速断开线程提示音 | `0x1763C` | `0x763C` | `2D F7 FF EB` | `00 00 A0 E1` |
| 正常断开提示音 | `0x1874C` | `0x874C` | `E9 F2 FF EB` | `00 00 A0 E1` |

这三个位置都是对 `system()` 的 `bl` 调用。`00 00 A0 E1` 是 ARM 的 `mov r0, r0`，相当于 NOP，不改变标志位。

补丁脚本：

```sh
python3 - <<'PY'
from pathlib import Path

p = Path("squashfs-root/usr/bin/mibt")
data = bytearray(p.read_bytes())

patches = [
    (0x7DEC, bytes.fromhex("41f5ffeb")),  # 连接提示音
    (0x763C, bytes.fromhex("2df7ffeb")),  # 快速断开线程提示音
    (0x874C, bytes.fromhex("e9f2ffeb")),  # 正常断开提示音
]

for off, old in patches:
    if data[off:off + 4] != old:
        raise SystemExit(f"unexpected bytes at {off:#x}: {data[off:off+4].hex()}")
    data[off:off + 4] = bytes.fromhex("0000a0e1")

p.write_bytes(data)
print("patched", p)
PY
```

这个方案只跳过提示音播放：

- 保留 `mediaplayer media_control connect/disconnect`；
- 保留 LED；
- 保留状态上报；
- 不影响蓝牙连接、断开和音频路由。

---

## 5. 验证

### 5.1 文件方案

```sh
ls -l /usr/share/sound/bluetooth_connect.opus
ls -l /usr/share/sound/bluetooth_disconnect.opus
```

两者都应为 `No such file or directory`。

`qplayer` 的实际实现是 `quickplayer`。文件不存在时，它会在 `op_open_file` 失败后打印：

```text
Failed to open file '...': ...
```

然后直接返回错误，没有 fallback 播放。

### 5.2 二进制方案

检查补丁后的文件：

```sh
hexdump -C -s 0x7DEC -n 4 squashfs-root/usr/bin/mibt
hexdump -C -s 0x763C -n 4 squashfs-root/usr/bin/mibt
hexdump -C -s 0x874C -n 4 squashfs-root/usr/bin/mibt
```

三处都应为：

```text
00 00 a0 e1
```

### 5.3 设备测试

手机重新连接音箱，再断开，确认没有提示音。必要时查看日志：

```sh
logread -f | grep -Ei 'mibt|qplayer|bluetooth'
```

---

## 6. 注意事项

1. **只处理 `bluetooth_connect.opus` 不够**  
   断开提示是另一个文件 `bluetooth_disconnect.opus`，两个都要处理。

2. **重新连接时的另一句提示**  
   如果听到的是“当前蓝牙已处于连接状态”，对应文件是 `bluetooth_already_connected.opus`，不是本文的两个目标。

3. **切换音色可能恢复提示音**  
   `mibrain_service` 在切换 TTS 音色时可能执行：
   ```sh
   rm -rf /data/sound
   ln -s /data/sound-vendor/<vendor> /data/sound
   ```
   这会覆盖运行时的可写目录，提示音恢复。需要重新处理，或使用重打包方案。

4. **OTA / 恢复出厂会恢复**  
   OTA 或清空 `/data` 后，`/data/sound` 会重新创建为只读 vendor 目录的符号链接。

5. **不要用 7z 解包后重打包**  
   7z 会丢失 `usr/share/sound -> /data/sound` 等符号链接，也会丢失设备节点。重打包请使用 `unsquashfs` / `mksquashfs`。

6. **恢复方法**  
   删除可写目录并重建符号链接：
   ```sh
   rm -rf /data/sound
   ln -s /usr/share/sound-vendor/AiNiRobot /data/sound
   ```
   如果当前音色不是 `AiNiRobot`，把路径换成实际的 `readlink -f /data/sound` 结果。

---

## 7. 分析依据

- `mibt` 中的命令字符串：
  - `ubus -t 1 call qplayer play '{"play":"/usr/share/sound/bluetooth_connect.opus"}' &`
  - `ubus -t 1 call qplayer play '{"play":"/usr/share/sound/bluetooth_disconnect.opus"}' &`
- 连接提示音调用点：虚拟地址 `0x17DEC`，位于 1500ms 定时器回调 `0x17DA8`。
- 断开提示音调用点：
  - 虚拟地址 `0x1763C`，位于快速断开线程 `0x175CC`；
  - 虚拟地址 `0x1874C`，位于正常断开处理 `0x18634`。
- 蓝牙事件来源：BlueZ D-Bus `org.bluez.Device1` 的 `Connected` 属性和 `org.bluez.MediaTransport1` 代理。
- `/usr/share/sound`、`/data/sound` 的建立逻辑位于 `/usr/sbin/boot_function.sh` 的 `sound_vendor_prepare()`。
- `qplayer` 的实际服务程序为 `/usr/bin/quickplayer`，缺失文件时走 `op_open_file` 失败分支，不做兜底播放。
