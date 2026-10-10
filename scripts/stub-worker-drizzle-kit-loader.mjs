import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * OpenNext bundles the Next server with esbuild. Turbopack externalizes drizzle-kit
 * under a hashed name (drizzle-kit-<hash>/api) and then excludes the package from the
 * trace, so esbuild cannot resolve it. drizzle-kit is only used to author migrations.
 * The Worker must not contain it. This loader wraps esbuild and replaces that hashed
 * require with a lazy stub.
 */
export function load(url, context, nextLoad) {
  if (!url.includes('/esbuild/lib/main.js')) {
    return nextLoad(url, context)
  }
  const source = readFileSync(fileURLToPath(url), 'utf8')
  if (source.includes('stub-hashed-drizzle-kit')) {
    return { format: 'commonjs', source, shortCircuit: true }
  }
  return {
    format: 'commonjs',
    source: `${source}\n${wrapper}`,
    shortCircuit: true,
  }
}

const wrapper = `
;(() => {
  var __jobsOriginalBuild = build;
  var __jobsStubPlugin = {
    name: "stub-hashed-drizzle-kit",
    setup: function(pluginBuild) {
      pluginBuild.onResolve({ filter: /^drizzle-kit-[0-9a-f]+(?:\\/|$)/ }, function(args) {
        return { path: args.path, namespace: "stub-hashed-drizzle-kit" };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "stub-hashed-drizzle-kit" }, function() {
        return {
          loader: "js",
          contents: "module.exports = new Proxy({}, { get: function(_target, prop) { if (prop === \\"__esModule\\" || prop === \\"then\\") return undefined; return function() { throw new Error(\\"drizzle-kit is not bundled into the Cloudflare Worker. Apply migrations with payload migrate.\\"); }; } });"
        };
      });
    }
  };
  build = function(options) {
    options = options || {};
    return Promise.resolve(__jobsOriginalBuild(Object.assign({}, options, {
      plugins: [__jobsStubPlugin].concat(options.plugins || [])
    }))).then(function(result) {
      var outfile = options.outfile;
      if (!outfile || String(outfile).indexOf("handler.mjs") === -1) return result;
      var fs = require("fs");
      var pathMod = require("path");
      var text = fs.readFileSync(outfile, "utf8");
      if (text.indexOf('endsWith("/server/preview-props.json")') !== -1) return result;
      var previewFile = [
        pathMod.join(process.cwd(), ".open-next/server-functions/default/.next/server/preview-props.json"),
        pathMod.join(process.cwd(), ".next/server/preview-props.json")
      ].filter(function(candidate) { return fs.existsSync(candidate); })[0];
      if (!previewFile) return result;
      var preview = fs.readFileSync(previewFile, "utf8").trim();
      var tick = String.fromCharCode(96);
      var pattern = new RegExp(
        "throw new Error\\\\(" + tick + "Unexpected loadManifest\\\\(" + "\\\\$" + "\\\\{" + "(\\\\w+)" + "\\\\}" + "\\\\) call!" + tick + "\\\\);?"
      );
      var replaced = text.replace(pattern, function(_match, name) {
        return 'if (' + name + '.endsWith("/server/preview-props.json")) return ' + preview + '; ' + _match;
      });
      if (replaced === text) return result;
      fs.writeFileSync(outfile, replaced);
      return result;
    });
  };
})();
`
