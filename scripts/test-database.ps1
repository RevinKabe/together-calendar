$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath '.tools/package/dist/index.js')) {
  New-Item -ItemType Directory -Force -Path '.tools' | Out-Null
  Invoke-WebRequest -Uri 'https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.13.tgz' -OutFile '.tools/pglite.tgz'
  tar -xf .tools/pglite.tgz -C .tools
  if ($LASTEXITCODE -ne 0) { throw 'PGlite extraction failed' }
}
node tests/database.mjs
exit $LASTEXITCODE
