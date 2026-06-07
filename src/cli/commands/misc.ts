import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireIdentifier } from "../shared.js";

export function registerMiscCommands(program: Command, deps: CliDeps): void {
  const archive = program.command("archive").description("MoWaS archive (historical warnings)");

  archive
    .command("mapping <identifier>")
    .description("Revision history for an archived MoWaS identifier")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.archive.mapping(requireIdentifier(id!, "identifier")));
      }),
    );

  archive
    .command("get <identifier>")
    .description("A specific archived MoWaS warning")
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await client.archive.get(requireIdentifier(id!, "identifier")));
      }),
    );

  const reference = program.command("reference").description("Static reference data");

  reference
    .command("notfalltipps")
    .description("Emergency-preparedness tips (German)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.reference.notfalltipps());
      }),
    );

  reference
    .command("event-codes")
    .description("The CAP event-code catalogue")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.reference.eventCodes());
      }),
    );

  reference
    .command("data-version")
    .description("Current data version/hash (useful for change detection)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.reference.dataVersion());
      }),
    );
}
