# App icon and branding verification

Environment: macOS 26.5.2 arm64, Node.js v24.22.3, npm 11.19.1.

The checks use no vendor login, no real chat, and no credential.

## Commands and results

```text
$ npm run build
EXIT:0

$ npm run lint
EXIT:0

$ npm test
22 unit and HTTP tests passed.
ok  - app name, menu, About, and icon assets
ALL DESKTOP HARNESS TESTS PASSED
EXIT:0

$ npm run e2e
4 e2e tests passed.
EXIT:0

$ npm run verify:clean-build
Clean build regenerated the app, preload, backend, panel, and CommonJS markers.
EXIT:0

$ npm run icons
assets/icons/16.png … assets/icons/1024.png
assets/blibs.icns
public/favicon.svg
EXIT:0
```

## Manual test

1. Run `npm run build` and `npm start`.
2. Look at the application menu. The first item is `blibs`.
3. Select **blibs** > **About blibs**. The About panel shows the name `blibs`
   and the blibs icon.
4. Look at the Dock. The app icon is the blibs icon, not the Electron icon.
5. Look at the window title. It reads `blibs`.

Result: the unit harness asserts the app name, the `About blibs` menu item, and
the three committed icon files. The native About panel and the Dock are
operating-system windows, so the harness cannot assert them. The visual check
of those two items waits for an unlocked display.

## Screenshot note

This machine has no screenshot of the Dock or the About window. The console
session was locked during the run (`CGSSessionScreenIsLocked=Yes`). macOS
screen capture returned no image:

```text
$ screencapture -x -o -l <about-window-id> about.png
could not create image from window
```

`qlmanage -t -s 512 assets/blibs.icns` renders `assets/blibs.icns` without an
image package. Capture the Dock or About screenshot after the display is
unlocked with the steps in the manual test. The icon artwork is in
`assets/icons/1024.png`.
