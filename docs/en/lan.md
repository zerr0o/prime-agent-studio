# Access from a phone

**English** · [Français](../lan.md) · [← Back to README](../../README.md)

## Use Studio from a phone

Mobile access is optional and protected by an eight-digit code. It provides Studio controls on the same Wi-Fi network: open projects and sessions, send messages, create or resume conversations, choose models, stop runs and organize projects and sessions. Agents work on the PC and continue when you close the phone’s browser.

On the PC, open **Preferences → Remote access** and enable **Local network**. Studio detects Wi-Fi and Ethernet interfaces. The connection opens immediately without restarting Studio or interrupting agents.

On first activation, save the eight-digit PIN shown once. Later LAN and Tailscale toggles preserve this code. **Copy link** copies the active address; **QR code** displays a QR containing only the URL, never the PIN. Scan it from a phone on the same network and enter the PIN. The authentication cookie lasts eight hours.

**Connection options** lets you select the interface and port. When changing the port, use the new link on your devices. A bind or save failure leaves the previous working connection intact. If an address disappears, the panel reports the error; refresh and select a connected interface. Configuration stays in `.local/lan-access.json`.

The default mobile port is `3089`, shared by LAN and Tailscale and bound only to the selected addresses. Port `3088` remains reserved for the PC. No router, Internet tunnel or Windows Firewall rule is configured. LAN uses HTTP on your local network. The PC must remain awake and connected; if the phone cannot connect despite an active listener, check its network and the PC firewall.

## Change the PIN on the PC

In the PC’s local interface, open **Preferences → Remote access → Change code**. Enter and confirm a new **8-digit** code; a leading zero is accepted. The same code is used for Wi-Fi, Tailscale and PWA access.

The change applies immediately without restarting Studio. Already-connected devices are signed out and must enter the new code; agents keep working. Addresses, ports and permissions stay the same. The code is stored neither in plain text on the PC nor in browser storage.

This panel and its routes are restricted to the PC’s local address. It changes already-configured mobile access; if you forget the old code, you can choose a new one from the PC.

![Changing the mobile code from desktop preferences, with confirmation of the new PIN.](../screenshots/en/desktop-remote-pin.png)

## Use remote controls

Choose a project from the menu to display its sessions, then tap a session to open it. **New session** prepares a conversation in that project. Archived sessions remain accessible through the **Archived** filter.

The **Photo** and **Attachment** buttons select images and any file type from the phone, respectively. Attachments transfer to the PC when sent, including through **Steer** or **Follow up**. Tap a received image to enlarge it, or a file to download it. Limits are the same as on desktop: [images and attachments](navigation.md#images-and-attachments).

The `readOnly: false` configuration enables remote controls. Choose **Read only** under **Remote permissions** to limit access to viewing. Older configurations without this field remain read-only until explicitly updated. Changes take effect immediately and preserve the PIN; devices must sign in again while agents keep working.

## Outside Wi-Fi with Tailscale

Install Tailscale on the PC and phone, connect them to the same Tailscale network—the same account for personal use—then enable the connection on both devices.

In **Preferences → Remote access**, enable **Tailscale**. The panel uses the connected Tailscale interface and displays `http://100.x.y.z:3089`. It preserves LAN, the port, PIN and permissions. First activation creates a PIN without enabling LAN. Studio does not install Tailscale or connect your account for you.

Activation is immediate. From the phone on 4G/5G, connect Tailscale and open the link or scan the QR. This HTTP access works without Tailscale Serve; [PWA installation](pwa.md) uses Serve for HTTPS. The **Tailscale HTTPS** card configures this access in the same panel without a restart, with its own link and QR.

Studio opens a second listener on the Tailscale interface’s IPv4 address, in addition to the LAN listener. This gateway accepts only peers in Tailscale’s `100.64.0.0/10` range and local connections; Studio authentication is still required. Tailscale encrypts traffic between devices. The model configurator and desktop-only routes remain unavailable remotely.

Configuration stays in `.local/lan-access.json`. The switches control LAN and HTTP Tailscale independently; the optional PWA gateway uses `tailscale.https.enabled`. They share the PIN and permissions, but each address needs its own browser sign-in. Disabling access closes its remote connections; agents and local access continue.

If Tailscale was unavailable at startup or its address changes, connect it, refresh the panel and apply its options. No Studio restart is needed.

If access fails from the phone, check that the PC is on, Tailscale is connected on both devices, and your Tailscale network and Windows Firewall rules allow the chosen port. A Tailscale startup error does not disable LAN access; diagnostics appear in `.local/logs/server.log`.

[Connecting devices: Tailscale documentation](https://tailscale.com/docs/how-to/connect-to-devices).

## Existing commands and upgrades

`npm run lan:enable` and `npm run tailscale:enable` remain available for terminal configuration. They edit the file used at the next startup; `lan:enable` also rotates the shared PIN. Use the panel to apply changes immediately and preserve the PIN.

Installing a new Studio version may need a restart: wait for active runs to finish because `npm run stop` interrupts them. Once this version is running, LAN, Tailscale, PIN and permission changes made in preferences apply without restarting. Closing a tab leaves agents working.
