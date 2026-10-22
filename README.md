# Jira Screen Comparator

CLI in TypeScript per confrontare l'ordine dei campi degli screen tra
Jira Data Center e Jira Cloud e, su richiesta esplicita, riordinare i
campi su Cloud seguendo l'ordine di Data Center.

## Funzionalità

-   Legge da file l'elenco degli screen da elaborare, uno per riga.
-   Recupera gli screen di Data Center e Cloud e li associa tramite il
    nome normalizzato.
-   Confronta l'ordine dei campi nelle tab corrispondenti.
-   Produce un report CSV con una riga per ogni screen elaborato.
-   Registra nel report gli esiti, gli eventuali campi aggiuntivi
    presenti su Cloud e gli ordini iniziale, desiderato e finale.
-   In modalità anteprima non modifica Jira Cloud.
-   Applica il riordino soltanto se viene specificato `--apply`.
-   Recupera l'elenco degli screen di ciascun ambiente una sola volta
    all'avvio, riutilizzandolo per tutte le schermate del file.
-   Dopo l'applicazione delle modifiche, rilegge i dettagli dello screen
    per verificare l'ordine risultante.

**Attenzione:** il comando con `--apply` modifica realmente la
configurazione degli screen su Jira Cloud. Data Center viene utilizzato
come riferimento e non viene modificato.

## Requisiti

-   Una versione di Node.js compatibile con il progetto e con `fetch`.
-   npm.
-   Accesso alle API REST di Jira Data Center e Jira Cloud.
-   Credenziali autorizzate a leggere gli screen in entrambi gli
    ambienti.
-   Permessi sufficienti per modificare gli screen su Cloud se si
    utilizza `--apply`.
-   Connettività verso Jira Data Center, inclusa l'eventuale VPN
    aziendale.

## Installazione

Dalla cartella del progetto:

``` bash
npm install
```

Il progetto deve avere uno script `sync` in `package.json` che esegua il
file TypeScript. Ad esempio, con `tsx`:

``` json
{
  "scripts": {
    "sync": "tsx src/index.ts"
  }
}
```

Se il progetto utilizza già un runner TypeScript diverso, mantieni la
configurazione esistente.

## Configurazione delle variabili d'ambiente

Crea un file `.env` nella root del progetto. Non committarlo e non
condividere token o password.

Esempio:

``` dotenv
# Jira Data Center
DC_BASE_URL=https://jira-uat.example.internal
DC_PAT=your-data-center-personal-access-token

# In alternativa al PAT, se supportato dall'istanza:
# DC_USERNAME=your-username
# DC_PASSWORD=your-password

# Jira Cloud
CLOUD_BASE_URL=https://your-site.atlassian.net
CLOUD_EMAIL=your-account@example.com
CLOUD_API_TOKEN=your-cloud-api-token
```

### Autenticazione

-   **Data Center:** se `DC_PAT` è valorizzato, viene utilizzato come
    Bearer token. In alternativa, il progetto può usare `DC_USERNAME` e
    `DC_PASSWORD` con Basic authentication, se questa modalità è
    configurata nel codice.
-   **Cloud:** viene utilizzata la Basic authentication con email
    Atlassian e API token.

Usa gli URL e le credenziali forniti dall'amministratore Jira. L'utente
API deve poter leggere gli screen e i relativi campi; per applicare il
riordino deve anche avere i permessi necessari su Cloud.

## Utilizzo

### 1. Preparare la lista degli screen

Crea un file di testo, ad esempio `screens.txt`, con il nome di uno
screen per riga:

``` text
# Screen da riordinare
ICT: Create Minaccia Cyber
ICT: View Minaccia Cyber
```

Le righe vuote e quelle che iniziano con `#` vengono ignorate.

Il nome deve corrispondere allo screen presente in entrambi gli
ambienti. Gli ID possono essere diversi tra Data Center e Cloud.

### 2. Eseguire l'anteprima

``` bash
npm run sync -- --reorder-screens-file screens.txt
```

Senza `--apply`, lo script confronta gli ordini, calcola il piano
desiderato e mostra i risultati nei log, senza inviare richieste di
modifica a Jira Cloud.

### 3. Applicare il riordino

``` bash
npm run sync -- --reorder-screens-file screens.txt --apply
```

Con `--apply`, lo script invia a Jira Cloud le richieste necessarie per
riordinare i campi. Al termine rilegge i dettagli degli screen per
verificare il risultato.

### 4. Report CSV

A ogni esecuzione viene generato automaticamente un CSV nella directory
`exports/`. Il nome include data e ora di esecuzione, per esempio:

``` text
exports/reorder-report-2026-10-22_10-15-30.csv
```

Non è necessario specificare il percorso del report tramite un argomento
CLI. La directory `exports/` viene creata automaticamente se non esiste.

Il CSV usa il punto e virgola come separatore, UTF-8 con BOM per
migliorare la compatibilità con Excel e intestazioni in italiano.

## Regole del riordino

Per ogni tab presente sia in Data Center sia in Cloud:

1.  I campi presenti in entrambi gli ambienti vengono ordinati secondo
    la sequenza di Data Center.
2.  I campi presenti solo in Data Center vengono ignorati, perché non
    possono essere ordinati su Cloud se non esistono lì.
3.  I campi presenti solo in Cloud vengono mantenuti in fondo alla tab,
    preservando il loro ordine relativo corrente.
4.  Le tab non vengono create, eliminate o riordinate.
5.  Le tab presenti soltanto in Data Center vengono ignorate.
6.  Viene modificato soltanto Jira Cloud; Data Center è usato come
    riferimento.

L'associazione dei campi si basa sul nome normalizzato, non sull'ID,
perché gli ID possono differire tra ambienti. Se nella stessa tab sono
presenti più campi con lo stesso nome, l'associazione potrebbe essere
ambigua.

## Colonne del report CSV

Il report contiene una riga per ogni screen richiesto. Le colonne sono:

  -----------------------------------------------------------------------
  Colonna                             Significato
  ----------------------------------- -----------------------------------
  Nome schermata                      Nome dello screen richiesto.

  ID schermata Jira Data Center       ID dello screen in Data Center, se
                                      trovato.

  ID schermata Jira Cloud             ID dello screen in Cloud, se
                                      trovato.

  Esito elaborazione                  Esito sintetico dell'elaborazione,
                                      ad esempio completata, già corretta
                                      o errore, secondo i valori
                                      registrati dallo script.

  Numero campi aggiuntivi su Cloud    Numero di campi presenti su Cloud
                                      ma non in Data Center.

  Campi aggiuntivi su Cloud           Elenco dei campi aggiuntivi
                                      rilevati su Cloud.

  Ordine iniziale dei campi su Cloud  Ordine dei campi rilevato prima del
                                      riordino.

  Ordine previsto dei campi           Ordine obiettivo calcolato a
                                      partire da Data Center, mantenendo
                                      in fondo i campi aggiuntivi di
                                      Cloud.

  Ordine finale dei campi su Cloud    Ordine rilevato al termine
                                      dell'elaborazione o della verifica.

  Dettaglio elaborazione              Informazioni aggiuntive sull'esito
                                      o sugli eventuali errori.
  -----------------------------------------------------------------------

Gli elenchi all'interno delle celle possono contenere più elementi. Se
una schermata non può essere letta o elaborata, controlla il dettaglio e
i log dell'esecuzione.

## Precauzioni

-   Esegui prima l'anteprima senza `--apply` e controlla attentamente
    gli ordini previsti.
-   Prova inizialmente su uno screen non critico.
-   Il riordino non è una transazione atomica: se una richiesta fallisce
    a metà, alcuni campi potrebbero essere già stati spostati.
-   In caso di errore, riesegui l'anteprima per verificare lo stato
    effettivo prima di riprovare.
-   Il comando non garantisce un rollback automatico.

## Diagnostica

### Lo screen non viene trovato

Controlla:

1.  Che `DC_BASE_URL` e `CLOUD_BASE_URL` puntino alle istanze corrette.
2.  Che il nome nel file corrisponda allo screen e non al nome di un
    progetto o di un issue type.
3.  Che l'utente o il token abbiano i permessi necessari.
4.  Che gli endpoint REST siano raggiungibili e restituiscano
    correttamente le pagine degli screen.

Lo script recupera l'elenco degli screen una sola volta per ambiente
all'avvio. Se un nome non viene trovato o non è univoco, verifica i nomi
restituiti da Jira e i log.

### Errori TLS o di connessione verso Data Center

Verifica che la VPN aziendale sia attiva, che il DNS risolva
correttamente l'hostname e che il certificato TLS del server sia valido
e corrisponda all'hostname utilizzato. Se l'errore persiste, chiedi al
team IT di verificare il certificato e la catena di certificazione.

Non disabilitare la verifica del certificato TLS come soluzione
permanente.

### Errori di autenticazione o permessi

-   `401`: controlla token, email, username e password.
-   `403`: verifica i permessi dell'utente API.
-   `404`: controlla URL base, versione API e ID dello screen.
-   Errori di rete: verifica VPN, DNS, proxy e raggiungibilità del
    server.
-   Errori durante il riordino: controlla il messaggio HTTP restituito
    da Jira Cloud e verifica i permessi di modifica degli screen.

## Struttura del progetto

La logica principale si trova in `src/index.ts`. Le responsabilità
includono:

-   lettura e validazione degli argomenti CLI;
-   recupero degli screen, delle tab e dei campi;
-   associazione degli screen tra Data Center e Cloud;
-   calcolo dell'ordine desiderato;
-   applicazione e verifica del riordino su Cloud;
-   generazione del report CSV.

## Sicurezza e manutenzione

-   Non salvare `.env` nel repository: aggiungilo a `.gitignore`.
-   Non inserire token o password nei log.
-   Usa token con i permessi minimi necessari.
-   Preferisci sempre una configurazione TLS valida.
-   Verifica che gli endpoint e il formato delle risposte siano
    compatibili con la versione della tua istanza Jira.
-   Controlla il report e i log al termine di ogni esecuzione.
