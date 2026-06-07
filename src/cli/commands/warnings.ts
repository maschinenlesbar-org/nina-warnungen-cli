import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson, renderRaw, requireIdentifier } from "../shared.js";
import { NinaSourceValues } from "../../client/enums.js";

export function registerWarningCommands(program: Command, deps: CliDeps): void {
  program
    .command("sources")
    .description("List the valid warning sources")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, [...NinaSourceValues]);
      }),
    );

  program
    .command("map-data <source>")
    .description(`Current warnings from a source (${NinaSourceValues.join(" | ")})`)
    .action(
      action(deps, async ({ client, global }, [source]) => {
        const s = assertEnum(source!, NinaSourceValues, "source");
        renderJson(deps, global, await client.mapData(s));
      }),
    );

  const warning = program.command("warning").description("A single warning by identifier");

  warning
    .command("get <identifier>")
    .description("Get the full CAP warning for an identifier")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.warnings.get(requireIdentifier(id!, "identifier")));
      }),
    );

  warning
    .command("geojson <identifier>")
    .description("Download the warning's geometry as GeoJSON (-o to write a file)")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        const geojson = await client.warnings.geojson(requireIdentifier(id!, "identifier"));
        renderRaw(deps, global, geojson, "json");
      }),
    );

  program
    .command("dashboard <ars>")
    .description("Warnings affecting a region (Amtlicher Regionalschlüssel / AGS)")
    .action(
      action(deps, async ({ client, global }, [ars]) => {
        renderJson(deps, global, await client.dashboard(requireIdentifier(ars!, "region key")));
      }),
    );
}
