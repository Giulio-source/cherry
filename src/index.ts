import "dotenv/config";

type JiraScreen = {
  id: number;
  name: string;
  description?: string;
};

type JiraTab = {
  id: number;
  name: string;
};

type JiraField = {
  id: string;
  name: string;
};

type ScreenSnapshot = {
  environment: string;
  screen: JiraScreen;
  tabs: Array<{
    tab: JiraTab;
    fields: JiraField[];
  }>;
};

type Page<T> = {
  values?: T[];
  total?: number;
  isLast?: boolean;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Variabile d'ambiente mancante: ${name}`);
  }

  return value.replace(/\/+$/, "");
}

function buildHeaders(environment: "dc" | "cloud") {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (environment === "cloud") {
    const email = requiredEnv("CLOUD_EMAIL");
    const token = requiredEnv("CLOUD_API_TOKEN");

    headers.Authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  } else if (process.env.DC_PAT?.trim()) {
    headers.Authorization = `Bearer ${process.env.DC_PAT.trim()}`;
  } else {
    const username = requiredEnv("DC_USERNAME");
    const password = requiredEnv("DC_PASSWORD");

    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  return headers;
}

function baseUrl(environment: "dc" | "cloud"): string {
  return requiredEnv(environment === "dc" ? "DC_BASE_URL" : "CLOUD_BASE_URL");
}

function apiVersion(environment: "dc" | "cloud"): string {
  return environment === "dc" ? "2" : "3";
}

async function jiraGet<T>(
  environment: "dc" | "cloud",
  endpoint: string,
): Promise<T> {
  const url =
    `${baseUrl(environment)}/rest/api/${apiVersion(environment)}` + endpoint;

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(environment),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `[${environment.toUpperCase()}] GET ${endpoint} ` +
        `→ HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  return response.json() as Promise<T>;
}

async function getAllScreens(
  environment: "dc" | "cloud",
): Promise<JiraScreen[]> {
  const screens: JiraScreen[] = [];
  const pageSize = 100;
  let startAt = 0;

  while (true) {
    const result = await jiraGet<JiraScreen[] | Page<JiraScreen>>(
      environment,
      `/screens?startAt=${startAt}&maxResults=${pageSize}`,
    );

    // Alcune versioni restituiscono un array, altre una pagina.
    if (Array.isArray(result)) {
      screens.push(...result);
      break;
    }

    const values = result.values ?? [];
    screens.push(...values);

    startAt += values.length;

    if (
      result.isLast === true ||
      values.length === 0 ||
      (result.total !== undefined && startAt >= result.total)
    ) {
      break;
    }
  }

  return screens;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function findScreen(
  environment: "dc" | "cloud",
  screenName: string,
): Promise<JiraScreen> {
  const screens = await getAllScreens(environment);

  const matches = screens.filter(
    (screen) => normalize(screen.name) === normalize(screenName),
  );

  if (matches.length === 0) {
    throw new Error(
      `[${environment.toUpperCase()}] Screen non trovato: "${screenName}"`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `[${environment.toUpperCase()}] Trovati più screen con nome ` +
        `"${screenName}". Selezione interrotta per sicurezza.`,
    );
  }

  return matches[0];
}

async function getScreenSnapshot(
  environment: "dc" | "cloud",
  screenName: string,
): Promise<ScreenSnapshot> {
  const screen = await findScreen(environment, screenName);

  const tabs = await jiraGet<JiraTab[]>(
    environment,
    `/screens/${screen.id}/tabs`,
  );

  const snapshotTabs = await Promise.all(
    tabs.map(async (tab) => {
      const fields = await jiraGet<JiraField[]>(
        environment,
        `/screens/${screen.id}/tabs/${tab.id}/fields`,
      );

      return { tab, fields };
    }),
  );

  return {
    environment: environment.toUpperCase(),
    screen,
    tabs: snapshotTabs,
  };
}

function printSnapshot(snapshot: ScreenSnapshot): void {
  console.log(`\n========== ${snapshot.environment} ==========`);

  console.log(
    JSON.stringify(
      {
        screen: snapshot.screen,
        tabs: snapshot.tabs.map(({ tab, fields }) => ({
          tab,
          fields: fields.map((field, index) => ({
            position: index + 1,
            ...field,
          })),
        })),
      },
      null,
      2,
    ),
  );
}

function compareSnapshots(dc: ScreenSnapshot, cloud: ScreenSnapshot): void {
  console.log("\n========== CONFRONTO ==========");

  console.log(
    `Screen: "${dc.screen.name}" | DC ID=${dc.screen.id} | ` +
      `Cloud ID=${cloud.screen.id}`,
  );

  const dcTabNames = dc.tabs.map(({ tab }) => normalize(tab.name));
  const cloudTabNames = cloud.tabs.map(({ tab }) => normalize(tab.name));

  const missingTabs = dc.tabs.filter(
    ({ tab }) => !cloudTabNames.includes(normalize(tab.name)),
  );

  const extraTabs = cloud.tabs.filter(
    ({ tab }) => !dcTabNames.includes(normalize(tab.name)),
  );

  console.log("\n-- Tab --");

  console.log(
    "Ordine tab DC:",
    dc.tabs.map(({ tab }) => tab.name).join(" → ") || "(nessuna)",
  );

  console.log(
    "Ordine tab Cloud:",
    cloud.tabs.map(({ tab }) => tab.name).join(" → ") || "(nessuna)",
  );

  console.log(
    "Tab mancanti su Cloud:",
    missingTabs.map(({ tab }) => tab.name),
  );

  console.log(
    "Tab aggiuntive su Cloud:",
    extraTabs.map(({ tab }) => tab.name),
  );

  if (
    missingTabs.length === 0 &&
    extraTabs.length === 0 &&
    dcTabNames.join("|") === cloudTabNames.join("|")
  ) {
    console.log("✓ Nomi e ordine delle tab corrispondono.");
  } else if (missingTabs.length === 0 && extraTabs.length === 0) {
    console.log(
      "! Le tab esistono in entrambi gli ambienti, ma l'ordine differisce.",
    );
  }

  console.log("\n-- Campi per tab --");

  for (const dcTab of dc.tabs) {
    const cloudTab = cloud.tabs.find(
      ({ tab }) => normalize(tab.name) === normalize(dcTab.tab.name),
    );

    console.log(`\nTab: "${dcTab.tab.name}"`);

    if (!cloudTab) {
      console.log("  ✗ Tab assente su Cloud; confronto campi impossibile.");
      continue;
    }

    const dcNames = dcTab.fields.map(({ name }) => normalize(name));
    const cloudNames = cloudTab.fields.map(({ name }) => normalize(name));

    const missingFields = dcTab.fields.filter(
      ({ name }) => !cloudNames.includes(normalize(name)),
    );

    const extraFields = cloudTab.fields.filter(
      ({ name }) => !dcNames.includes(normalize(name)),
    );

    console.log(
      "  DC:",
      dcTab.fields.map(({ name }) => name).join(" → ") || "(nessun campo)",
    );

    console.log(
      "  Cloud:",
      cloudTab.fields.map(({ name }) => name).join(" → ") || "(nessun campo)",
    );

    console.log(
      "  Mancanti su Cloud:",
      missingFields.map(({ name, id }) => `${name} [${id}]`),
    );

    console.log(
      "  Aggiuntivi su Cloud:",
      extraFields.map(({ name, id }) => `${name} [${id}]`),
    );

    if (missingFields.length === 0 && extraFields.length === 0) {
      if (dcNames.join("|") === cloudNames.join("|")) {
        console.log("  ✓ Campi presenti nello stesso ordine.");
      } else {
        console.log("  ! Stessi nomi di campo, ma ordine differente.");

        // Segnala anche i campi che occupano posizioni diverse.
        for (let i = 0; i < dcNames.length; i++) {
          if (dcNames[i] !== cloudNames[i]) {
            console.log(
              `    Posizione ${i + 1}: DC="${dcTab.fields[i].name}", ` +
                `Cloud="${cloudTab.fields[i].name}"`,
            );
          }
        }
      }
    }
  }

  console.log("\n========== FINE CONFRONTO ==========");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const screenIndex = args.indexOf("--screen");
  const screenName =
    screenIndex >= 0 ? args[screenIndex + 1]?.trim() : undefined;

  if (!screenName || screenName.startsWith("--")) {
    throw new Error('Uso: npm run sync -- --screen "Nome esatto dello screen"');
  }

  console.log(`Screen richiesto: "${screenName}"`);
  console.log("Modalità: sola lettura; nessuna modifica verrà eseguita.");

  const [dcSnapshot, cloudSnapshot] = await Promise.all([
    getScreenSnapshot("dc", screenName),
    getScreenSnapshot("cloud", screenName),
  ]);

  printSnapshot(dcSnapshot);
  printSnapshot(cloudSnapshot);
  compareSnapshots(dcSnapshot, cloudSnapshot);
}

main().catch((error: unknown) => {
  console.error("\nERRORE:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
