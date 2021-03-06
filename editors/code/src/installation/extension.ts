import * as vscode from "vscode";
import * as path from "path";
import { promises as fs } from 'fs';

import { vscodeReinstallExtension, vscodeReloadWindow, log, vscodeInstallExtensionFromVsix, assert, notReentrant } from "../util";
import { Config, UpdatesChannel } from "../config";
import { ArtifactReleaseInfo, ArtifactSource } from "./interfaces";
import { downloadArtifactWithProgressUi } from "./downloads";
import { fetchArtifactReleaseInfo } from "./fetch_artifact_release_info";

const HEURISTIC_NIGHTLY_RELEASE_PERIOD_IN_HOURS = 25;

/**
 * Installs `stable` or latest `nightly` version or does nothing if the current
 * extension version is what's needed according to `desiredUpdateChannel`.
 */
export async function ensureProperExtensionVersion(config: Config): Promise<never | void> {
    // User has built lsp server from sources, she should manage updates manually
    if (config.serverSource?.type === ArtifactSource.Type.ExplicitPath) return;

    const currentUpdChannel = config.installedExtensionUpdateChannel;
    const desiredUpdChannel = config.updatesChannel;

    if (currentUpdChannel === UpdatesChannel.Stable) {
        // Release date is present only when we are on nightly
        await config.installedNightlyExtensionReleaseDate.set(null);
    }

    if (desiredUpdChannel === UpdatesChannel.Stable) {
        // VSCode should handle updates for stable channel
        if (currentUpdChannel === UpdatesChannel.Stable) return;

        if (!await askToDownloadProperExtensionVersion(config)) return;

        await vscodeReinstallExtension(config.extensionId);
        await vscodeReloadWindow(); // never returns
    }

    if (currentUpdChannel === UpdatesChannel.Stable) {
        if (!await askToDownloadProperExtensionVersion(config)) return;

        return await tryDownloadNightlyExtension(config);
    }

    const currentExtReleaseDate = config.installedNightlyExtensionReleaseDate.get();

    if (currentExtReleaseDate === null) {
        void vscode.window.showErrorMessage(
            "Nightly release date must've been set during the installation. " +
            "Did you download and install the nightly .vsix package manually?"
        );
        throw new Error("Nightly release date was not set in globalStorage");
    }

    const dateNow = new Date;
    const hoursSinceLastUpdate = diffInHours(currentExtReleaseDate, dateNow);
    log.debug(
        "Current rust-analyzer nightly was downloaded", hoursSinceLastUpdate,
        "hours ago, namely:", currentExtReleaseDate, "and now is", dateNow
    );

    if (hoursSinceLastUpdate < HEURISTIC_NIGHTLY_RELEASE_PERIOD_IN_HOURS) {
        return;
    }
    if (!await askToDownloadProperExtensionVersion(config, "The installed nightly version is most likely outdated. ")) {
        return;
    }

    await tryDownloadNightlyExtension(config, releaseInfo => {
        assert(
            currentExtReleaseDate.getTime() === config.installedNightlyExtensionReleaseDate.get()?.getTime(),
            "Other active VSCode instance has reinstalled the extension"
        );

        if (releaseInfo.releaseDate.getTime() === currentExtReleaseDate.getTime()) {
            vscode.window.showInformationMessage(
                "Whoops, it appears that your nightly version is up-to-date. " +
                "There might be some problems with the upcomming nightly release " +
                "or you traveled too far into the future. Sorry for that 😅! "
            );
            return false;
        }
        return true;
    });
}

async function askToDownloadProperExtensionVersion(config: Config, reason = "") {
    if (!config.askBeforeDownload) return true;

    const stableOrNightly = config.updatesChannel === UpdatesChannel.Stable ? "stable" : "latest nightly";

    // In case of reentering this function and showing the same info message
    // (e.g. after we had shown this message, the user changed the config)
    // vscode will dismiss the already shown one (i.e. return undefined).
    // This behaviour is what we want, but likely it is not documented

    const userResponse = await vscode.window.showInformationMessage(
        reason + `Do you want to download the ${stableOrNightly} rust-analyzer extension ` +
        `version and reload the window now?`,
        "Download now", "Cancel"
    );
    return userResponse === "Download now";
}

/**
 * Shutdowns the process in case of success (i.e. reloads the window) or throws an error.
 *
 * ACHTUNG!: this function has a crazy amount of state transitions, handling errors during
 * each of them would result in a ton of code (especially accounting for cross-process
 * shared mutable `globalState` access). Enforcing no reentrancy for this is best-effort.
 */
const tryDownloadNightlyExtension = notReentrant(async (
    config: Config,
    shouldDownload: (releaseInfo: ArtifactReleaseInfo) => boolean = () => true
): Promise<never | void> => {
    const vsixSource = config.nightlyVsixSource;
    try {
        const releaseInfo = await fetchArtifactReleaseInfo(vsixSource.repo, vsixSource.file, vsixSource.tag);

        if (!shouldDownload(releaseInfo)) return;

        await downloadArtifactWithProgressUi(releaseInfo, vsixSource.file, vsixSource.dir, "nightly extension");

        const vsixPath = path.join(vsixSource.dir, vsixSource.file);

        await vscodeInstallExtensionFromVsix(vsixPath);
        await config.installedNightlyExtensionReleaseDate.set(releaseInfo.releaseDate);
        await fs.unlink(vsixPath);

        await vscodeReloadWindow(); // never returns
    } catch (err) {
        log.downloadError(err, "nightly extension", vsixSource.repo.name);
    }
});

function diffInHours(a: Date, b: Date): number {
    // Discard the time and time-zone information (to abstract from daylight saving time bugs)
    // https://stackoverflow.com/a/15289883/9259330

    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());

    return (utcA - utcB) / (1000 * 60 * 60);
}
