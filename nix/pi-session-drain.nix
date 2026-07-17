{ lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      pname = "pi-session-drain";
      version = "0.1.0";
      packageName = "pi-session-drain";
      packagePath = "lib/node_modules/${packageName}";
      package = pkgs.stdenvNoCC.mkDerivation {
        inherit pname version;
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../package.json
            ../README.md
            ../SPEC.md
            ../extensions
          ];
        };

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/${packagePath}"
          cp -R package.json README.md SPEC.md extensions "$out/${packagePath}/"
          runHook postInstall
        '';

        doInstallCheck = true;
        nativeInstallCheckInputs = [ pkgs.nodejs_22 ];
        installCheckPhase = ''
          runHook preInstallCheck
          pkg="$out/${packagePath}"
          test -f "$pkg/package.json"
          test -f "$pkg/extensions/session-drain.ts"
          node - "$pkg/package.json" <<'NODE'
          const fs = require("fs");
          const [manifestPath] = process.argv.slice(2);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (manifest.name !== "pi-session-drain") throw new Error("unexpected package name: " + manifest.name);
          if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("./extensions")) {
            throw new Error("missing Pi extension metadata for ./extensions");
          }
          NODE
          runHook postInstallCheck
        '';

        passthru.packagePath = "${placeholder "out"}/${packagePath}";

        meta = {
          description = "Pi extension for discovering, paging, and marking session-drain state";
          homepage = "https://github.com/rrvsh/pi-session-drain";
          license = lib.licenses.mit;
          platforms = [
            "aarch64-darwin"
            "x86_64-linux"
          ];
        };
      };
      packageWithPassthru = package.overrideAttrs (old: {
        passthru = (old.passthru or { }) // {
          packagePath = "${package}/${packagePath}";
        };
      });
    in
    {
      packages.pi-session-drain = packageWithPassthru;
      packages.default = packageWithPassthru;
    };
}
