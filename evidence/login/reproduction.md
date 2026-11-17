# In-app sign-in and first-run verification

Environment: macOS arm64, Node.js v24.22.3, npm 11.19.1.

All vendor login data in these checks is mocked. The check uses no vendor
account, no real verification code, and no cookie.

## Commands and results

```text
$ npm run build
EXIT:0

$ npm run lint
EXIT:0

$ npm test
22 unit and HTTP tests passed.
ALL DESKTOP HARNESS TESTS PASSED
EXIT:0

$ npm run e2e
4 e2e tests passed.
EXIT:0

$ npm run verify:clean-build
Clean build regenerated the app, preload, backend, panel, and CommonJS markers.
EXIT:0
```

The e2e harness starts the real app with `BLIBS_MOCK_LOGIN=1`. It uses a
temporary profile and a temporary history store. The mocked sign-in reports an
opening step, a loading step, and a mobile verification step. Select **Check
again** to complete the mocked sign-in.

## Manual checks

1. Open `onboarding-dark.png` and `onboarding-light.png`. The first-run card
   shows the four steps. **Back** is disabled on step 1. **Skip** is present.
2. Open `login-dark.png` and `login-light.png`. The agents screen lists Muse,
   Dots, and Grok. The Muse row shows the mocked mobile verification step.
   **Check again**, **Open window**, and **Cancel** are visible.
3. Open `home-after-login-dark.png` and `home-after-login-light.png`. The chat
   panel is back after the mocked sign-in completed and Escape was pressed.

The screenshots use the mock chats from `tests/e2e/harness.ts`.
