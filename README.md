# Jira Screen Comparator

CLI in TypeScript per confrontare la configurazione degli screen tra
Jira Data Center e Jira Cloud e, su richiesta esplicita, riordinare i
campi degli screen su Cloud secondo l'ordine di Data Center.

## Funzionalità

-   Cerca uno screen tramite il nome.
-   Recupera screen, tab e campi tramite API REST.
-   Confronta presenza e ordine di tab e campi.
-   Stampa gli snapshot e i confronti in console.
-   Elabora una lista di screen da file e genera un CSV con **una riga
    per screen**.
-   Registra nel report gli errori di lettura.
-   Offre un comando separato per pianificare il riordino dei campi su
    Cloud.
-   Applica il riordino su Cloud soltanto se viene specificato
    `--apply`.

Il comando di confronto è pensato per la sola lettura. Il comando
`--reorder-screen` può invece modificare la configurazione di Jira Cloud
quando viene usato con `--apply`.

## Requisiti

-   Node.js con supporto a `fetch`.
-   npm.
-   Accesso alle API REST di Jira Data Center e Jira Cloud.
-   Credenziali o token autorizzati a leggere gli screen.
-   Permessi sufficienti per modificare la configurazione degli screen
    su Cloud se si usa `--apply`.
-   Connettività verso Jira Data Center, inclusa l'eventuale VPN
    aziendale.

## Installazione

Dalla cartella del progetto:

``` bash
npm install
npm install undici
```

Verifica che `package.json` contenga uno script `sync` compatibile con
il progetto. Per esempio, se usi `tsx`:

``` json
{
  "scripts": {
    "sync": "tsx src/index.ts"
  }
}
```

Se il progetto usa già un altro runner TypeScript, mantieni quello
configurato.

## Configurazione delle variabili d'ambiente

Crea un file `.env` nella root del progetto. Non committarlo e non
condividere token o password.

Esempio indicativo:

``` dotenv
# Jira Data Center
DC_BASE_URL=https://jira-uat.example.internal
DC_PAT=your-data-center-personal-access-token

# In alternativa al PAT, se supportato dalla propria istanza:
# DC_USERNAME=your-username
# DC_PASSWORD=your-password

# Jira Cloud
CLOUD_BASE_URL=https://your-site.atlassian.net
CLOUD_EMAIL=your-account@example.com
CLOUD_API_TOKEN=your-cloud-api-token
```

### Autenticazione

-   **Data Center:** se `DC_PAT` è valorizzato, viene usato come Bearer
    token. Altrimenti vengono usati `DC_USERNAME` e `DC_PASSWORD` in
    Basic authentication.
-   **Cloud:** viene usata la Basic authentication con email Atlassian e
    API token.

Usa URL e credenziali forniti dall'amministratore Jira. L'utente API
deve poter leggere gli screen e i relativi campi. Per applicare il
riordino, l'utente Cloud deve inoltre disporre dei permessi necessari a
modificare la configurazione degli screen.

## Comandi

### 1. Confrontare un singolo screen

``` bash
npm run sync -- --screen "Nome esatto dello screen"
```

Recupera lo screen da entrambi gli ambienti, stampa gli snapshot e
mostra il confronto in console. Questo comando non modifica la
configurazione Jira e non genera il CSV batch.

### 2. Confrontare una lista di screen e generare un CSV

Crea un file di testo, ad esempio `screens.txt`, con uno screen per
riga:

``` text
# Screen relativi agli incident
ICT: View Incident Jira Work Management Screen
ICT: Edit Incident Screen
ICT: Create Incident Screen
```

Sono ignorate le righe vuote e le righe che iniziano con `#`.

Esegui:

``` bash
npm run sync -- --screens-file screens.txt --csv risultati.csv
```

Se ometti `--csv`, il nome predefinito è `jira-screen-comparison.csv`.

Il percorso del CSV è relativo alla directory da cui viene lanciato il
comando, a meno che non venga indicato un percorso assoluto.

### 3. Riordinare i campi di uno screen su Cloud

Il comando confronta l'ordine dei campi tra Data Center e Cloud e
prepara un piano di riordino.

**Anteprima senza modifiche:**

``` bash
npm run sync -- --reorder-screen "ICT: View Incident Jira Work Management Screen"
```

**Applicazione delle modifiche su Cloud:**

``` bash
npm run sync -- --reorder-screen "ICT: View Incident Jira Work Management Screen" --apply
```

Senza `--apply`, il comando mostra gli ordini attuale e desiderato senza
eseguire chiamate di modifica. Con `--apply`, invia le richieste di
spostamento a Jira Cloud e poi rilegge lo screen per verificare il
risultato.

#### Regole del riordino

Per ogni tab presente in entrambi gli ambienti:

1.  I campi presenti sia in Data Center sia in Cloud vengono ordinati
    secondo la sequenza di Data Center.
2.  I campi presenti solo in Data Center vengono ignorati perché non
    possono essere ordinati su Cloud se non esistono lì.
3.  I campi presenti solo in Cloud vengono mantenuti e spostati in fondo
    alla tab, preservando il loro ordine relativo corrente.
4.  Le tab non vengono create, eliminate o riordinate.
5.  Le tab presenti soltanto in Data Center vengono ignorate.
6.  Il comando modifica soltanto Cloud; Data Center viene usato come
    riferimento.

L'associazione dei campi tra gli ambienti si basa sul nome normalizzato,
non sull'ID, perché gli ID possono differire. Se nella stessa tab ci
sono più campi con lo stesso nome, il confronto potrebbe essere ambiguo.

#### Precauzioni

-   Esegui prima l'anteprima e controlla attentamente il piano.
-   Prova inizialmente su uno screen non critico.
-   Il comando con `--apply` modifica realmente la configurazione di
    Cloud.
-   Se una richiesta fallisce a metà, alcuni campi potrebbero essere già
    stati spostati. Riesegui l'anteprima per verificare lo stato
    effettivo prima di riprovare.
-   Il comando non è una transazione atomica: non garantisce un rollback
    automatico in caso di errore.

## CSV: una riga per screen

Il CSV batch contiene una riga per ogni screen presente nel file di
input, anche se non è stato possibile leggerlo da uno dei due ambienti.

  -----------------------------------------------------------------------
  Colonna                             Significato
  ----------------------------------- -----------------------------------
  `screen`                            Nome dello screen richiesto

  `dcScreenId`                        ID dello screen in Data Center, se
                                      trovato

  `cloudScreenId`                     ID dello screen in Cloud, se
                                      trovato

  `status`                            `OK`, `DIFFERENZE` oppure `ERRORE`

  `missingTabs`                       Tab presenti in DC ma assenti in
                                      Cloud

  `extraTabs`                         Tab presenti in Cloud ma assenti in
                                      DC

  `missingFields`                     Campi presenti in DC ma assenti in
                                      Cloud, con il nome della tab

  `extraFields`                       Campi presenti in Cloud ma assenti
                                      in DC, con il nome della tab

  `orderDifferences`                  Differenze nell'ordine delle tab o
                                      dei campi

  `errors`                            Errori di lettura in uno o entrambi
                                      gli ambienti
  -----------------------------------------------------------------------

Gli elenchi all'interno delle colonne sono separati da `|`. Il CSV usa
UTF-8 con BOM per migliorare la compatibilità con Excel.

### Interpretazione degli stati

-   **`OK`**: non sono state rilevate differenze in presenza e ordine
    delle tab e dei campi.
-   **`DIFFERENZE`**: è stata rilevata almeno una differenza.
-   **`ERRORE`**: non è stato possibile recuperare lo screen da almeno
    uno degli ambienti.

La posizione dei campi è confrontata all'interno della rispettiva tab.

## Diagnostica

### Lo screen non viene trovato

Controlla:

1.  Che `DC_BASE_URL` e `CLOUD_BASE_URL` puntino alle istanze corrette.
2.  Che il nome sia quello dello screen, non quello di un progetto o di
    un issue type.
3.  Che l'utente o il token abbiano i permessi necessari.
4.  I log delle chiamate `/rest/api/2/screens` in Data Center e
    `/rest/api/3/screens` in Cloud.

Se la risposta dichiara un `total` maggiore di zero ma non contiene
elementi, registra le proprietà presenti nel JSON e verifica la
struttura di paginazione della versione Jira in uso. Non assumere che
tutte le istanze restituiscano lo stesso formato.

### Errore TLS in Data Center

La configurazione attuale può usare `rejectUnauthorized: false` per le
richieste Data Center. Questo disabilita la verifica del certificato TLS
e riduce la sicurezza della connessione.

È un workaround temporaneo, da usare soltanto in un ambiente fidato. La
soluzione raccomandata è correggere il certificato, installare la CA
aziendale appropriata oppure utilizzare l'hostname corretto indicato dal
team IT. Non disabilitare globalmente la verifica TLS di Node.js.

### Errori di autenticazione o permessi

-   `401`: controlla token, email, username e password.
-   `403`: verifica i permessi dell'utente API.
-   `404`: controlla URL base, versione API e ID dello screen.
-   Errori di rete: verifica VPN, DNS, proxy e raggiungibilità del
    server.
-   Errori durante il riordino: controlla il messaggio HTTP restituito
    da Jira Cloud e verifica i permessi di modifica degli screen.

## Struttura del progetto

La logica principale si trova in `src/index.ts`. Le responsabilità sono
separate in funzioni per:

-   costruire gli header e le URL API;
-   recuperare gli screen, le tab e i campi;
-   creare gli snapshot;
-   confrontare gli snapshot;
-   creare il report sintetico per screen;
-   esportare il CSV;
-   calcolare il piano di riordino;
-   applicare e verificare il riordino su Cloud.

## Sicurezza e manutenzione

-   Non salvare `.env` nel repository: aggiungilo a `.gitignore`.
-   Non inserire token o password nei log.
-   Usa token con i permessi minimi necessari.
-   Preferisci una configurazione TLS valida rispetto alla
    disattivazione della verifica del certificato.
-   Verifica che gli endpoint e il formato delle risposte siano
    compatibili con la versione della tua istanza Jira.
-   Esegui sempre l'anteprima del riordino prima di usare `--apply`.
