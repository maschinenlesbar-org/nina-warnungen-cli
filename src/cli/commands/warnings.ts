import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, renderRaw } from "../shared.js";
import { NinaSourceValues, type NinaSource } from "../../client/enums.js";

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
        renderJson(deps, global, await client.mapData(source as NinaSource));
      }),
    );

  const warning = program.command("warning").description("A single warning by identifier");

  warning
    .command("get <identifier>")
    .description("Get the full CAP warning for an identifier")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.warnings.get(id!));
      }),
    );

  warning
    .command("geojson <identifier>")
    .description("Download the warning's geometry as GeoJSON (-o to write a file)")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        const geojson = await client.warnings.geojson(id!);
        renderRaw(deps, global, geojson, "json");
      }),
    );

  program
    .command("dashboard <ars>")
    .description("Warnings affecting a district, by its district-level ARS (12 digits, last 7 digits 0; " +
        "not a state key such as 050000000000, which the API answers with [])")
    .action(
      action(deps, async ({ client, global }, [ars]) => {
        renderJson(deps, global, await client.dashboard(ars!));
      }),
    );
}
