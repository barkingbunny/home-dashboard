# home-dashboard

Úvodní stránka domácího displeje: starý tablet na zdi zobrazuje v kiosk prohlížeči
jednu statickou stránku s dlaždicemi.

Stránka běží na GitHub Pages: <https://barkingbunny.github.io/home-dashboard/>

## Co zobrazuje

- den, datum a kdo má svátek (tabulka `svatky.js`)
- předpověď na dnešek po hodinách, ťuknutím výhled na 5 dalších dní (Open-Meteo)
- digitální hodiny
- světla (Philips Hue): obývák se scénami Den / Čtení / Relax / Vypnout a lampa u gauče;
  ťuknutí = scéna nebo zapnout/vypnout, tažení prstem po tlačítku nahoru a dolů = jas;
  stránka `svetla.html` se všemi místnostmi
- rozcestník: lišta Teploty vody s maximem čidla Měřák TUV z poslední dávky (ThingSpeak) a odkaz Světla

## Soubory

| Soubor | Obsah |
|---|---|
| `index.html` | kostra stránky |
| `style.css` | vzhled; celá stránka je 60×96 rem, 1 rem se počítá z viewportu |
| `app.js` | konfigurace (`CONFIG` nahoře), stahování dat, probuzení displeje, kontrola verze |
| `icons.js` | ikony počasí (SVG) a tabulka kód WMO → ikona + české slovo |
| `svatky.js` | český občanský kalendář, 366 dní |
| `version.json` | číslo nasazené verze |
| `hue.js` | volání Hue Bridge (místní rozhraní v1) |
| `svetla.html` | všechny místnosti a světla |
| `svetla-nastaveni.html` | jednorázové nastavení: `?bridge=<IP>`, pak stisk tlačítka na bridgi |
| `ikony.html` | přehled všech ikon a slov (jen pro kontrolu) |
| `robots.txt` | zákaz indexování |

## Technicky

Čisté HTML, CSS a JavaScript bez build kroku a bez knihoven. Data si stránka bere přímo
z veřejných API, server není potřeba. Cílové zařízení má starý prohlížeč (WebView 95, odpovídá
Chrome 95), 1 GB RAM a viewport 602×961 CSS px na výšku – nepoužívat novější syntaxi ani
`backdrop-filter`.

Odkud jsou data:

| Data | Zdroj | Obnova |
|---|---|---|
| předpověď | `api.open-meteo.com` | 30 min |
| teploty vody | `api.thingspeak.com`, kanál 3529108, `field8` | 5 min |
| světla | Hue Bridge v domácí síti | 15 s |

Adresa bridge a přístupový klíč jsou jen v `localStorage` tabletu, do repozitáře nepatří.
Rozhraní v2 bridge z prohlížeče volat nejde (nepovolí hlavičku s klíčem), proto v1.
Názvy místnosti, lampy a scén jsou v `CONFIG.lights` v `app.js`.

Chování, se kterým kód počítá:

- Displej tabletu po minutě zhasne. Probuzení stránka pozná událostí `visibilitychange` a skokem
  v čase mezi tiky. Při probuzení opraví čas, obnoví zastaralá data a stáhne `version.json`.
- Nepovedený požadavek se opakuje za 2, 5 a 15 s, pak až v běžném intervalu; hned také při
  události `online`. Poslední data jsou v `localStorage` a po načtení se ukážou okamžitě.
- Stará data jsou ztlumená s textem „obnovuji“, „bez spojení“ nebo „poslední měření“.
- Stránka se sama znovu načte jen při probuzení, a jen když se povedlo stáhnout `version.json`
  a ten hlásí jinou verzi, nebo když stránka běží déle než 12 hodin.
- Odkaz v rozcestníku nejdřív ověří, že je cíl dostupný; bez spojení se neodchází.

## Nasazení nové verze

1. Zvyš číslo verze na obou místech: `version.json` a `APP_VERSION` v `index.html` (a `?v=` v `svetla.html`).
2. Commit a push do `main`. Tablet si novou verzi načte při dalším probuzení displeje;
   číslo verze je vidět vpravo dole.

## Ladění

- `?debug=1` – panel s rozměry viewportu, verzí, stavem zdrojů dat a zachycenými chybami
- `?debug=1&reloadAfter=2` – zkrátí hranici 12 hodin pro znovunačtení na 2 minuty
- `?demo=1` – ukázková data bez sítě

Místní spuštění: `python -m http.server` v kořeni repozitáře a otevřít `http://localhost:8000/`.

## Zdroje dat a licence

- Předpověď: [Open-Meteo.com](https://open-meteo.com/), licence CC BY 4.0.
- Svátky: cs.wikipedia.org „Jmeniny v Česku“, porovnáno se svatkyapi.cz.
