# Releasing Frame Studio

How to publish a new version of the macOS app, and how to try an update before you do. ADR 0009 explains the updater.

Installed apps look for `latest-mac.yml` on the newest GitHub release of emrosas/frame-studio that is neither a draft nor a prerelease. They check 10 s after launch, every 4 hours, and from Frame Studio › Check for Updates…. A release is the tag `v<version>` with three files: `Frame-Studio-<version>-arm64-mac.zip` (what the updater downloads), `Frame-Studio-<version>-arm64.dmg` (for new installs) and `latest-mac.yml`.

You need `gh`, signed in with push rights to the repo (`gh auth status`).

## Cut a release

1. Pick the version. Apps compare versions as semver, so it has to be higher than the last release's.
2. Set it without tagging, which updates `package.json` and `package-lock.json`:

   ```sh
   npm version 0.2.0 --no-git-tag-version
   ```

3. Commit and push to main:

   ```sh
   git commit -am "Release 0.2.0"
   git push origin main
   ```

4. Build the release:

   ```sh
   npm run desktop:release
   ```

   It stops if `v0.2.0` is already on origin, if HEAD isn't on origin/main, or if a file that ships in the app has uncommitted changes (`src/`, `desktop/`, `tools/`, `public/`, the pages, `vite.config.ts`, the package files and the two samples). Other files, such as test scenes, may be dirty. It builds the app, the DMG and the zip into `build/desktop/dist/`, checks that the zip unpacks to an app of this version with its framework symlinks, writes `latest-mac.yml` there, and prints the `gh` command that would publish them.

5. Check the build. Open the DMG and start the app from it. Run the packaged tests, which install the release zip and update it:

   ```sh
   npx vitest run --config vitest.browser.config.ts tests/browser/packaged.test.ts tests/browser/packaged-update.test.ts
   ```

6. Publish:

   ```sh
   npm run desktop:release -- --publish
   ```

   This builds again from the same commit and runs `gh release create v0.2.0 … --target <HEAD> --generate-notes`, which also creates the tag. To upload the files you already checked instead, run the command step 4 printed.

7. Open the release page. It should be marked Latest and have the three files. Installed apps offer the update within 4 hours, or at once from Check for Updates….

Don't publish a release as a draft or a prerelease if apps should get it: `releases/latest` skips both. To pull a bad release, mark it as a prerelease or delete it. Apps that haven't updated go back to the release before it, and apps that already updated stay on the bad one until you publish a higher version.

## Try an update locally

The automated test does the whole thing against a local feed, with the app in a temporary Applications folder:

```sh
npm run desktop:build -- --release
npx vitest run --config vitest.browser.config.ts tests/browser/packaged-update.test.ts
```

By hand, with a real version bump:

1. Build the current version and copy it somewhere you can write to. This is the "installed" app.

   ```sh
   npm run desktop:build
   mkdir -p ~/fs-update-test
   ditto "build/desktop/dist/mac-arm64/Frame Studio.app" ~/fs-update-test/"Frame Studio.app"
   ```

2. Build a higher version, without committing it:

   ```sh
   npm version 0.0.1 --no-git-tag-version
   npm run desktop:build -- --release
   ```

3. Write its feed and serve the folder. Any static server works.

   ```sh
   cd build/desktop/dist
   ZIP=Frame-Studio-0.0.1-arm64-mac.zip
   SHA=$(openssl dgst -sha512 -binary "$ZIP" | openssl base64 -A)
   cat > latest-mac.yml <<EOF
   version: 0.0.1
   files:
     - url: $ZIP
       sha512: $SHA
       size: $(stat -f %z "$ZIP")
   path: $ZIP
   sha512: $SHA
   releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
   EOF
   python3 -m http.server 8765 --bind 127.0.0.1
   ```

4. In another terminal, start the installed copy on that feed, with its own settings folder so it doesn't meet the single-instance lock of a Frame Studio you already run:

   ```sh
   FRAME_STUDIO_UPDATE_FEED=http://127.0.0.1:8765/ FRAME_STUDIO_USER_DATA=/tmp/fs-update-test \
     ~/fs-update-test/"Frame Studio.app/Contents/MacOS/Frame Studio"
   ```

5. Pick Frame Studio › Check for Updates…, then Update. The app quits and opens again as 0.0.1, and the relaunched app keeps both variables. The swap script's log is `/tmp/fs-update-test/logs/update.log`.

6. Clean up: stop the server, quit the app, and undo the bump.

   ```sh
   git checkout package.json package-lock.json
   rm -rf ~/fs-update-test /tmp/fs-update-test
   ```

Check for Updates… appears only in the installed app or with `FRAME_STUDIO_UPDATE_FEED` set. Run from the repo with that variable, the app finds updates but can't install them, since it isn't a bundle it can replace.
