const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the actual server-only packaging block without rebranding customer
// files, downloading Electron, or publishing an OTA release.
for (const file of [
  path.join(__dirname, 'build-customer.js'),
  path.join(__dirname, '..', '..', 'scripts', 'build-customer.js'),
]) {
  const source = fs.readFileSync(file, 'utf8')
  const block = source.match(/substep\('electron-builder \(server\)', \(\) => \{([\s\S]*?)\n    \}\)/)
  assert.ok(block, `Server-only packaging block exists in ${file}`)
  for (const root of ['C:\\Build Folder\\walok', '/tmp/build folder/walok']) {
    const platformPath = root.startsWith('C:') ? path.win32 : path.posix
    const output = platformPath.join(root, 'server', 'dist-electron-job')
    const calls = []
    vm.runInNewContext(block[1], {
      ROOT: root,
      serverOutDir: output,
      path: platformPath,
      log() {},
      run(command, cwd) { calls.push({ command, cwd }) },
    })
    assert.deepEqual(calls, [{
      command: 'npx electron-builder -c.directories.output=' + JSON.stringify(output),
      cwd: platformPath.join(root, 'server'),
    }], 'Pass the isolated output flag directly to the server packager')
    assert.ok(!calls[0].command.includes('npm run dist:server'), 'No nested npm flag forwarding')
  }
}
console.log('PASS: both server-only build scripts invoke the server packager directly, including paths with spaces')
