# HuiDots unattended Windows deployment

HuiDots runs Paperclip as an unattended Windows host. The supported upstream
Paperclip service manager currently supports systemd and launchd, not native
Windows services. HuiDots therefore uses Windows Task Scheduler as the native
boot supervisor while continuing to use Paperclip's normal `run --instance`
entrypoint, embedded PostgreSQL lifecycle, and `/api/health` contract.

Install from an elevated PowerShell prompt:

```powershell
& .\windows\Install-HuiDotsUnattended.ps1
```

The installer starts both tasks and runs the local acceptance check before it
returns. A nonzero exit means installation or acceptance did not complete.

The installer creates two independent boot-triggered tasks running as
`NT AUTHORITY\SYSTEM`, so no interactive login or open terminal is required:

- `HuiDots-Paperclip-Unattended` runs a bounded health supervisor. It waits up
  to two minutes for embedded PostgreSQL crash recovery and Paperclip startup,
  then checks the full API health response every 30 seconds. Three consecutive
  failures terminate only that supervised process tree and restart it.
- `HuiDots-Cloudflare-Unattended` runs `cloudflared` directly, allowing Task
  Scheduler to observe exit and restart it. It keeps Paperclip bound to
  loopback; Cloudflare Tunnel remains the external transport.

The installer disables the older HuiDots tasks because they were logon-only,
interactive, battery-sensitive, or detached their child process from Task
Scheduler supervision.

The installer also sets the active Windows power scheme's AC sleep timeout to
Never. Pass `-KeepAcSleepEnabled` only for a host that has another intentional
wake/availability design. Display timeout and battery sleep settings are not
changed.

Verify after install or reboot:

```powershell
& .\windows\Test-HuiDotsUnattended.ps1
```

The check requires both boot tasks, a healthy and bootstrapped API on port
3100, a working local UI origin, and a running Cloudflare tunnel process.
Cloudflare Access intentionally protects the public health path, so public
acceptance must be performed with an authenticated Access session or service
token rather than weakening the access policy.

Tailscale is independent of these tasks. Its Windows service must remain set to
Automatic and running. Windows sleep must be disabled for an unattended server;
a service cannot recover or accept SSH while the host is suspended.
