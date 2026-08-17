# Consistência da digestão — `probes/digest/degrau-3-v4.json`

Medida sem chamar modelo e sem tocar no banco: só o `.json` do artefato e o
`.md` irmão. Mercados com o mesmo hash receberam a mesma regra, byte a byte.

**Ressalva:** a digestão recebe `question` e `outcomes` além da `description`.
Mercados do mesmo grupo têm a mesma REGRA e perguntas diferentes — parte da
divergência é prompt diferente, não temperatura. Isto é TETO de instabilidade.

| medida | valor |
| --- | ---: |
| digestões | 728 |
| textos de regra distintos | 191 |
| grupos com 2+ mercados | 79 |
| mercados nesses grupos | 616 (84.6%) |
| grupos com saída divergente | 79 (100.0%) |
| mercados com a saída modal do grupo | 226 (36.7%) |

## Volatilidade por tipo de ambiguidade

| tipo | em todos os membros | em ALGUNS |
| --- | ---: | ---: |
| `fuso_ausente` | 31 | 38 |
| `criterio_discricionario` | 19 | 31 |
| `formato_do_mercado` | 0 | 31 |
| `fonte_vaga` | 24 | 24 |
| `outro` | 2 | 24 |
| `data_ambigua` | 1 | 23 |
| `escopo_de_entidade` | 0 | 22 |
| `momento_ambiguo` | 3 | 21 |
| `precedencia_de_fonte` | 16 | 15 |
| `contradicao_interna` | 0 | 14 |
| `janela_inclusiva` | 1 | 10 |
| `limiar_de_borda` | 0 | 7 |

## Contradição interna: recall ou precisão?

Só os grupos divididos. Se os dois trechos citados existem no texto, quem não
acusou tinha as passagens na frente e não as ligou — falha de recall, e a lista
de contradições segue válida, só incompleta.

| medida | valor |
| --- | ---: |
| acusações conferidas | 16 |
| ambos os trechos no texto → recall | 16 (100.0%) |
| algum trecho fora do texto → precisão | 0 (0.0%) |

## Os grupos divergentes, do maior para o menor

### hash `0fba60e03908` — 44 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-lionel-messi-be-the-1-searched-person-on-google-this-year-20260717214426260 |
| 3 | 1 | will-zendaya-be-the-1-searched-person-on-google-this-year-20260717214426295 |
| 3 | 2 | will-matt-damon-be-the-1-searched-person-on-google-this-year-20260717214426253 |
| 3 | 4 | will-kanye-west-be-the-1-searched-person-on-google-this-year-20260717214426255 |
| 4 | 2 | will-shohei-ohtani-be-the-1-searched-person-on-google-this-year-20260717214426281 |
| 3 | 2 | will-ariana-grande-be-the-1-searched-person-on-google-this-year-20260717214426279 |
| 3 | 0 | will-lamine-yamal-be-the-1-searched-person-on-google-this-year-20260717214426257 |
| 3 | 3 | will-scarlett-johansson-be-the-1-searched-person-on-google-this-year-20260717214426288 |
| 2 | 1 | will-taylor-swift-be-the-1-searched-person-on-google-this-year-20260717214426269 |
| 4 | 3 | will-patrick-mahomes-be-the-1-searched-person-on-google-this-year-20260717214426285 |
| 2 | 1 | will-cristiano-ronaldo-be-the-1-searched-person-on-google-this-year-20260717214426256 |
| 3 | 3 | will-ja-morant-be-the-1-searched-person-on-google-this-year-20260717214426293 |
| 3 | 1 | will-bad-bunny-be-the-1-searched-person-on-google-this-year-20260717214426277 |
| 2 | 1 | will-jacob-elordi-be-the-1-searched-person-on-google-this-year-20260717214426278 |
| 2 | 3 | will-donald-trump-be-the-1-searched-person-on-google-this-year-20260717214426268 |
| 3 | 2 | will-billie-eilish-be-the-1-searched-person-on-google-this-year-20260717214426272 |
| 3 | 2 | will-elon-musk-be-the-1-searched-person-on-google-this-year-20260717214426271 |
| 4 | 3 | will-robert-downey-jrpt-be-the-1-searched-person-on-google-this-year-20260717214426254 |
| 4 | 2 | will-jd-vance-be-the-1-searched-person-on-google-this-year-20260717214426280 |
| 2 | 2 | will-joe-burrow-be-the-1-searched-person-on-google-this-year-20260717214426283 |
| 3 | 2 | will-timothee-chalamet-be-the-1-searched-person-on-google-this-year-20260717214426284 |
| 3 | 1 | will-chappell-roan-be-the-1-searched-person-on-google-this-year-20260717214426287 |
| 2 | 3 | will-angel-reese-be-the-1-searched-person-on-google-this-year-20260717214426286 |
| 2 | 2 | will-erling-haaland-be-the-1-searched-person-on-google-this-year-20260717214426262 |
| 3 | 3 | will-kylian-mbappe-be-the-1-searched-person-on-google-this-year-20260717214426261 |
| 2 | 2 | will-lebron-james-be-the-1-searched-person-on-google-this-year-20260717214426274 |
| 3 | 2 | will-luka-doncic-be-the-1-searched-person-on-google-this-year-20260717214426289 |
| 2 | 3 | will-caitlin-clark-be-the-1-searched-person-on-google-this-year-20260717214426276 |
| 4 | 1 | will-jude-bellingham-be-the-1-searched-person-on-google-this-year-20260717214426264 |
| 3 | 3 | will-scottie-scheffler-be-the-1-searched-person-on-google-this-year-20260717214426292 |
| 3 | 1 | will-neymar-be-the-1-searched-person-on-google-this-year-20260717214426258 |
| 3 | 2 | will-alysa-liu-be-the-1-searched-person-on-google-this-year-20260717214426259 |
| 3 | 2 | will-jake-paul-be-the-1-searched-person-on-google-this-year-20260717214426294 |
| 3 | 2 | will-volodymyr-zelenskyy-be-the-1-searched-person-on-google-this-year-20260717214426266 |
| 2 | 1 | will-christian-pulisic-be-the-1-searched-person-on-google-this-year-20260717214426263 |
| 3 | 2 | will-benjamin-netanyahu-be-the-1-searched-person-on-google-this-year-20260717214426298 |
| 4 | 2 | will-travis-kelce-be-the-1-searched-person-on-google-this-year-20260717214426275 |
| 4 | 3 | will-josh-allen-be-the-1-searched-person-on-google-this-year-20260717214426282 |
| 3 | 2 | will-vladimir-putin-be-the-1-searched-person-on-google-this-year-20260717214426265 |
| 3 | 2 | will-sydney-sweeney-be-the-1-searched-person-on-google-this-year-20260717214426267 |
| 2 | 2 | will-nicolas-maduro-be-the-1-searched-person-on-google-this-year-20260717214426297 |
| 3 | 3 | will-pedro-pascal-be-the-1-searched-person-on-google-this-year-20260717214426273 |
| 2 | 2 | will-anthony-edwards-be-the-1-searched-person-on-google-this-year-20260717214426290 |
| 3 | 2 | will-sabrina-carpenter-be-the-1-searched-person-on-google-this-year-20260717214426270 |

### hash `d054d6123c18` — 28 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-raphinha-win-the-2026-ballon-dor |
| 1 | 1 | 7c34fe7a-0f90-4e8f-a22c-5346d5a788a9 |
| 1 | 0 | will-lamine-yamal-win-the-2026-ballon-dor |
| 2 | 2 | will-dominik-szoboszlai-win-the-2026-ballon-dor |
| 0 | 1 | will-bruno-fernandes-win-the-2026-ballon-dor |
| 0 | 1 | will-kylian-mbapp-win-the-2026-ballon-dor |
| 1 | 1 | will-vitinha-win-the-2026-ballon-dor |
| 1 | 1 | will-julian-alvarez-win-the-2026-ballon-dor |
| 1 | 1 | will-desire-doue-win-the-2026-ballon-dor |
| 3 | 2 | will-michael-olise-win-the-2026-ballon-dor |
| 2 | 2 | will-mohamed-salah-win-the-2026-ballon-dor |
| 2 | 1 | will-khvicha-kvaratskhelia-win-the-2026-ballon-dor |
| 1 | 1 | will-ousmane-dembl-win-the-2026-ballon-dor |
| 1 | 1 | will-enzo-fernandez-win-the-2026-ballon-dor |
| 1 | 2 | will-harry-kane-win-the-2026-ballon-dor |
| 1 | 1 | 6bde1ce4-0185-4084-9643-daff4ee5d75c |
| 1 | 1 | will-lautaro-martinez-win-the-2026-ballon-dor |
| 2 | 1 | will-rodri-win-the-2026-ballon-dor |
| 2 | 1 | will-cristiano-ronaldo-win-the-2026-ballon-dor |
| 1 | 2 | will-jude-bellingham-win-the-2026-ballon-dor |
| 0 | 0 | will-luis-diaz-win-the-2026-ballon-dor |
| 2 | 1 | will-erling-haaland-win-the-2026-ballon-dor |
| 1 | 2 | will-achraf-hakimi-win-the-2026-ballon-dor |
| 1 | 1 | will-declan-rice-win-the-2026-ballon-dor |
| 2 | 2 | will-rodrygo-win-the-2026-ballon-dor |
| 1 | 0 | will-vincius-jnior-win-the-2026-ballon-dor |
| 1 | 0 | will-bukayo-saka-win-the-2026-ballon-dor |
| 1 | 1 | will-cole-palmer-win-the-2026-ballon-dor |

### hash `0aba46a10a8e` — 27 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-ali-asghar-hejazi-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-reza-pirzadeh-be-head-of-state-in-iran-end-of-2026 |
| 2 | 2 | 3a6d8d7b-744e-4c89-90b9-057d58b3f056 |
| 2 | 2 | will-sadegh-mahsouli-be-head-of-state-in-iran-end-of-2026 |
| 3 | 3 | will-navid-shomali-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-saeed-jalili-be-head-of-state-in-iran-end-of-2026 |
| 3 | 3 | will-mohammad-bagher-ghalibaf-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-reza-pahlavi-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-massoud-rajavi-be-head-of-state-in-iran-end-of-2026 |
| 3 | 3 | will-hassan-shariatmadari-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-mohammad-khatami-be-head-of-state-in-iran-end-of-2026 |
| 3 | 4 | will-ahmad-vahidi-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-ali-motahari-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-ahmad-hosseini-khorasani-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-abbas-araghchi-be-head-of-state-in-iran-end-of-2026 |
| 3 | 3 | will-there-be-no-head-of-state-in-iran-end-of-2026 |
| 3 | 1 | will-mojtaba-khamenei-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-maryam-rajavi-be-head-of-state-in-iran-end-of-2026 |
| 2 | 2 | will-hassan-rouhani-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-mohsen-araki-be-head-of-state-in-iran-end-of-2026 |
| 2 | 3 | will-mostafa-pourmohammadi-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-nasir-hosseini-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-sadegh-larijani-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-alireza-arafi-be-head-of-state-in-iran-end-of-2026 |
| 4 | 2 | will-gholam-ali-haddad-adel-be-head-of-state-in-iran-end-of-2026 |
| 3 | 2 | will-muhammad-mirbaqiri-be-head-of-state-in-iran-end-of-2026 |
| 4 | 3 | will-mustafa-hijri-be-head-of-state-in-iran-end-of-2026 |

### hash `789348b98098` — 26 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 1 | will-the-minnesota-twins-win-the-2026-world-series |
| 2 | 1 | will-the-cleveland-guardians-win-the-2026-world-series |
| 2 | 2 | will-the-new-york-yankees-win-the-2026-world-series |
| 2 | 2 | will-the-tampa-bay-rays-win-the-2026-world-series |
| 2 | 3 | will-the-atlanta-braves-win-the-2026-world-series |
| 2 | 3 | will-the-boston-red-sox-win-the-2026-world-series |
| 2 | 1 | will-the-baltimore-orioles-win-the-2026-world-series |
| 2 | 5 | will-the-houston-astros-win-the-2026-world-series |
| 0 | 2 | will-the-athletics-win-the-2026-world-series |
| 2 | 2 | will-the-colorado-rockies-win-the-2026-world-series |
| 2 | 3 | will-the-miami-marlins-win-the-2026-world-series |
| 3 | 3 | will-the-los-angeles-dodgers-win-the-2026-world-series |
| 2 | 3 | will-the-arizona-diamondbacks-win-the-2026-world-series |
| 2 | 1 | will-the-chicago-cubs-win-the-2026-world-series |
| 2 | 3 | will-the-pittsburgh-pirates-win-the-2026-world-series |
| 2 | 3 | will-the-chicago-white-sox-win-the-2026-world-series |
| 2 | 3 | will-the-kansas-city-royals-win-the-2026-world-series |
| 2 | 2 | will-the-san-francisco-giants-win-the-2026-world-series |
| 2 | 2 | ed3ee7f6-f606-464c-8308-d4c97b5927d2 |
| 0 | 1 | will-the-cincinnati-reds-win-the-2026-world-series |
| 2 | 2 | will-the-texas-rangers-win-the-2026-world-series |
| 2 | 2 | will-the-philadelphia-phillies-win-the-2026-world-series |
| 2 | 1 | will-the-milwaukee-brewers-win-the-2026-world-series |
| 2 | 3 | will-the-seattle-mariners-win-the-2026-world-series |
| 2 | 3 | will-the-washington-nationals-win-the-2026-world-series |
| 2 | 2 | 22565277-6614-45fd-a38c-e6dbffdccf35 |

### hash `da876e4456f5` — 21 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 1 | will-oscar-piastri-be-the-2026-f1-drivers-champion |
| 3 | 2 | will-alexander-albon-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-valtteri-bottas-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-lance-stroll-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-fernando-alonso-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-george-russell-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-sergio-prez-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-franco-colapinto-be-the-2026-f1-drivers-champion |
| 2 | 2 | will-lewis-hamilton-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-charles-leclerc-be-the-2026-f1-drivers-champion |
| 3 | 2 | will-carlos-sainz-jr-be-the-2026-f1-drivers-champion |
| 3 | 2 | will-pierre-gasly-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-max-verstappen-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-arvid-lindblad-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-esteban-ocon-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-liam-lawson-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-gabriel-bortoleto-be-the-2026-f1-drivers-champion |
| 4 | 1 | will-lando-norris-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-isack-hadjar-be-the-2026-f1-drivers-champion |
| 2 | 1 | will-nico-hlkenberg-be-the-2026-f1-drivers-champion |
| 3 | 1 | will-kimi-antonelli-be-the-2026-f1-drivers-champion |

### hash `43c4bf4589be` — 21 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | bitcoin-above-76k-on-august-16-2026 |
| 3 | 1 | bitcoin-above-74k-on-august-16-2026 |
| 2 | 2 | bitcoin-above-68k-on-august-14-2026 |
| 3 | 1 | bitcoin-above-56k-on-august-16-2026 |
| 2 | 1 | bitcoin-above-70k-on-august-16-2026 |
| 2 | 1 | bitcoin-above-58k-on-august-16-2026 |
| 3 | 2 | bitcoin-above-68k-on-august-16-2026 |
| 3 | 2 | bitcoin-above-54k-on-august-14-2026 |
| 3 | 2 | bitcoin-above-72k-on-august-15-2026 |
| 3 | 1 | bitcoin-above-56k-on-august-15-2026 |
| 3 | 2 | 473974a5-06fb-4f15-8946-3983156ef2e6 |
| 3 | 1 | bitcoin-above-66k-on-august-14-2026 |
| 2 | 2 | bitcoin-above-74k-on-august-15-2026 |
| 2 | 3 | bitcoin-above-58k-on-august-14-2026 |
| 3 | 1 | bitcoin-above-74k-on-august-14-2026 |
| 3 | 1 | bitcoin-above-68k-on-august-15-2026 |
| 4 | 3 | bitcoin-above-76k-on-august-15-2026 |
| 3 | 1 | bitcoin-above-72k-on-august-16-2026 |
| 3 | 2 | bitcoin-above-56k-on-august-14-2026 |
| 3 | 1 | bitcoin-above-70k-on-august-14-2026 |
| 3 | 1 | bitcoin-above-72k-on-august-14-2026 |

### hash `2ef4f973747e` — 20 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-stephen-cloobeck-win-the-california-governor-election-in-2026 |
| 3 | 2 | will-betty-yee-win-the-california-governor-election-in-2026 |
| 3 | 4 | will-katie-porter-win-the-california-governor-election-in-2026 |
| 2 | 2 | will-kyle-langford-win-the-california-governor-election-in-2026 |
| 2 | 3 | will-rick-caruso-win-the-california-governor-election-in-2026 |
| 2 | 1 | will-alex-padilla-win-the-california-governor-election-in-2026 |
| 3 | 3 | will-toni-atkins-win-the-california-governor-election-in-2026 |
| 3 | 4 | will-tom-steyer-win-the-california-governor-election-in-2026 |
| 2 | 3 | will-elaine-culotti-win-the-california-governor-election-in-2026 |
| 3 | 4 | will-butch-ware-win-the-california-governor-election-in-2026 |
| 2 | 3 | will-michael-younger-win-the-california-governor-election-in-2026 |
| 2 | 4 | will-steve-hilton-win-the-california-governor-election-in-2026 |
| 3 | 3 | will-nicole-shanahan-win-the-california-governor-election-in-2026 |
| 3 | 5 | will-eleni-kounalakis-win-the-california-governor-election-in-2026 |
| 1 | 3 | will-kamala-harris-win-the-california-governor-election-in-2026 |
| 3 | 3 | will-daniel-mercuri-win-the-california-governor-election-in-2026 |
| 2 | 1 | will-eric-swalwell-win-the-california-governor-election-in-2026 |
| 2 | 3 | will-matt-mahan-win-the-california-governor-election-in-2026 |
| 2 | 2 | will-tony-thurmond-win-the-california-governor-election-in-2026 |
| 2 | 3 | will-leo-zacky-win-the-california-governor-election-in-2026 |

### hash `45d0e3782c44` — 17 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 4 | will-gideon-saar-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-yoaz-hendel-be-the-next-prime-minister-of-israel |
| 3 | 3 | will-amir-ohana-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-israel-katz-be-the-next-prime-minister-of-israel |
| 4 | 3 | will-yair-golan-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-nir-barkat-be-the-next-prime-minister-of-israel |
| 4 | 4 | will-yair-lapid-be-the-next-prime-minister-of-israel |
| 4 | 1 | will-yossi-cohen-be-the-next-prime-minister-of-israel |
| 2 | 2 | will-gilad-erdan-be-the-next-prime-minister-of-israel |
| 5 | 3 | will-yariv-levin-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-gadi-eizenkot-be-the-next-prime-minister-of-israel |
| 2 | 2 | will-naftali-bennett-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-benny-gantz-be-the-next-prime-minister-of-israel |
| 4 | 3 | will-benjamin-netanyahu-be-the-next-prime-minister-of-israel |
| 3 | 2 | will-avigdor-lieberman-be-the-next-prime-minister-of-israel |
| 2 | 2 | will-ayelet-shaked-be-the-next-prime-minister-of-israel |
| 3 | 1 | will-itamar-ben-gvir-be-the-next-prime-minister-of-israel |

### hash `4dec9855e900` — 17 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 4 | will-helder-barbalho-win-the-2026-brazilian-presidential-election |
| 2 | 3 | will-flvio-bolsonaro-win-the-2026-brazilian-presidential-election |
| 2 | 3 | will-luiz-incio-lula-da-silva-win-the-2026-brazilian-presidential-election |
| 2 | 3 | will-eduardo-bolsonaro-win-the-2026-brazilian-presidential-election |
| 3 | 3 | 438952ab-5ab9-4104-af5a-b27ce8c35fbe |
| 1 | 3 | will-michelle-bolsonaro-win-the-2026-brazilian-presidential-election |
| 3 | 3 | will-aldo-rebelo-win-the-2026-brazilian-presidential-election |
| 2 | 3 | will-ronaldo-caiado-win-the-2026-brazilian-presidential-election |
| 2 | 4 | will-tereza-cristina-win-the-2026-brazilian-presidential-election |
| 1 | 3 | will-geraldo-alckmin-win-the-2026-brazilian-presidential-election |
| 2 | 3 | will-romeu-zema-win-the-2026-brazilian-presidential-election |
| 3 | 3 | will-camilo-santana-win-the-2026-brazilian-presidential-election |
| 2 | 4 | will-tarcisio-de-frietas-win-the-2026-brazilian-presidential-election |
| 3 | 3 | will-eduardo-leite-win-the-2026-brazilian-presidential-election |
| 3 | 3 | will-carlos-roberto-massa-jnior-win-the-2026-brazilian-presidential-election |
| 2 | 2 | will-fernando-haddad-win-the-2026-brazilian-presidential-election |
| 1 | 4 | will-jair-bolsonaro-win-the-2026-brazilian-presidential-election |

### hash `fd1330c8354d` — 17 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 5 | will-fernando-haddad-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-ronaldo-caiado-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-renan-santos-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-tarcisio-de-freitas-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 1 | 3 | will-geraldo-alckmin-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-eduardo-bolsonaro-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 2 | will-helder-barbalho-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 4 | will-carlos-roberto-massa-jnior-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-flvio-bolsonaro-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 3 | will-tereza-cristina-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-camilo-santana-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 3 | will-jair-bolsonaro-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 4 | 5 | will-michelle-bolsonaro-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-eduardo-leite-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-luiz-incio-lula-da-silva-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 2 | will-aldo-rebelo-finish-in-second-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 2 | d598a7c1-98e2-4e2a-8ab4-04d4b131ef4f |

### hash `471418ee38e3` — 16 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | will-michelle-bolsonaro-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-tarcisio-de-freitas-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 3 | will-carlos-roberto-massa-jnior-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 3 | will-fernando-haddad-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-aldo-rebelo-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 2 | will-romeu-zema-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-eduardo-leite-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 5 | 727e60ac-15ea-4297-99bb-89560ca38833 |
| 3 | 4 | will-flvio-bolsonaro-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 4 | 4 | will-luiz-incio-lula-da-silva-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 4 | 4 | will-eduardo-bolsonaro-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-geraldo-alckmin-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-tereza-cristina-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 4 | will-camilo-santana-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 4 | will-ronaldo-caiado-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |
| 2 | 3 | will-renan-santos-finish-in-third-place-in-the-first-round-of-the-2026-brazilian-presidential-election |

### hash `545d2d6e82d2` — 15 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-partido-democrtico-trabalhista-pdt-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 2 | 1 | will-avante-avante-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 2 | 3 | will-federao-brasil-da-esperana-fe-brasil-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 4 | will-republicanos-republicanos-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 2 | 3 | will-federao-unio-progressista-upb-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 3 | will-movimento-democrtico-brasileiro-mdb-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 3 | will-partido-novo-novo-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 2 | will-federao-psol-rede-psol-rede-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 2 | will-partido-misso-misso-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 4 | 3 | will-podemos-pode-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 3 | will-partido-socialista-brasileiro-psb-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 2 | 2 | will-federao-renovao-solidria-prd-solidariedade-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 3 | will-partido-liberal-pl-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 3 | 5 | will-federao-psdb-cidadania-psdb-cidadania-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |
| 4 | 4 | will-partido-social-democrtico-psd-hold-the-most-seats-in-the-brazilian-chamber-of-deputies-after-the-2026-election |

### hash `d5fd02af7e03` — 13 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 0 | will-7-fed-rate-cuts-happen-in-2026 |
| 6 | 2 | will-1-fed-rate-cut-happen-in-2026 |
| 2 | 0 | will-no-fed-rate-cuts-happen-in-2026 |
| 5 | 3 | will-9-fed-rate-cuts-happen-in-2026 |
| 5 | 2 | will-5-fed-rate-cuts-happen-in-2026 |
| 4 | 2 | will-12-or-more-fed-rate-cuts-happen-in-2026 |
| 6 | 1 | will-3-fed-rate-cuts-happen-in-2026 |
| 6 | 3 | will-6-fed-rate-cuts-happen-in-2026 |
| 5 | 1 | will-8-fed-rate-cuts-happen-in-2026 |
| 4 | 2 | will-11-fed-rate-cuts-happen-in-2026 |
| 5 | 2 | will-10-fed-rate-cuts-happen-in-2026 |
| 5 | 2 | will-2-fed-rate-cuts-happen-in-2026 |
| 5 | 1 | will-4-fed-rate-cuts-happen-in-2026 |

### hash `901dea9e0015` — 13 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-xiaomi-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210293 |
| 3 | 2 | will-microsoft-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210305 |
| 6 | 3 | will-deepseek-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210295 |
| 5 | 2 | will-anthropic-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210285 |
| 6 | 2 | will-mistral-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210301 |
| 4 | 3 | will-minimax-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210300 |
| 4 | 2 | will-zptai-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210292 |
| 6 | 4 | will-baidu-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210291 |
| 5 | 3 | will-nvidia-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210298 |
| 4 | 3 | will-amazon-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210296 |
| 4 | 3 | will-tencent-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210303 |
| 3 | 2 | will-meituan-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210302 |
| 4 | 2 | will-thinky-have-the-best-ai-model-at-the-end-of-august-2026-20260717020210299 |

### hash `7be1ca7be043` — 13 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-lindbergh-farias-win-the-governor-of-rio-de-janeiro-election-20260608202950324 |
| 2 | 3 | will-fred-pacheco-win-the-governor-of-rio-de-janeiro-election-20260608202950329 |
| 1 | 3 | will-nicola-miccione-win-the-governor-of-rio-de-janeiro-election-20260608202950326 |
| 3 | 4 | will-wilson-witzel-win-the-governor-of-rio-de-janeiro-election-20260608202950322 |
| 4 | 3 | will-anthony-garotinho-win-the-governor-of-rio-de-janeiro-election-20260608202950321 |
| 2 | 3 | will-andre-portugues-win-the-governor-of-rio-de-janeiro-election-20260608202950323 |
| 3 | 3 | will-tarcisio-motta-win-the-governor-of-rio-de-janeiro-election-20260608202950320 |
| 2 | 2 | will-candidate-d-win-the-governor-of-rio-de-janeiro-election-20260608202950333 |
| 3 | 3 | will-chico-machado-win-the-governor-of-rio-de-janeiro-election-20260608202950328 |
| 3 | 3 | will-felipe-curi-win-the-governor-of-rio-de-janeiro-election-20260608202950325 |
| 4 | 4 | will-eduardo-paes-win-the-governor-of-rio-de-janeiro-election |
| 2 | 4 | will-drpt-luizinho-win-the-governor-of-rio-de-janeiro-election-20260608202950318 |
| 3 | 3 | will-douglas-ruas-win-the-governor-of-rio-de-janeiro-election |

### hash `6fc1dc7b05f1` — 13 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-teach-you-a-lesson-be-the-1-searched-tv-show-on-google-this-year-20260730185304481 |
| 5 | 3 | will-swapped-be-the-1-searched-tv-show-on-google-this-year-20260730185304500 |
| 5 | 3 | f4e766a9-9cd3-4330-b1d2-e34cb45927eb |
| 4 | 2 | will-one-piece-be-the-1-searched-tv-show-on-google-this-year-20260730185304505 |
| 4 | 3 | will-monster-the-lizzie-borden-story-be-the-1-searched-tv-show-on-google-this-year-20260730185304516 |
| 3 | 2 | will-ted-lasso-be-the-1-searched-tv-show-on-google-this-year-20260730185304503 |
| 5 | 3 | will-malcolm-in-the-middle-be-the-1-searched-tv-show-on-google-this-year-20260730185304509 |
| 4 | 2 | will-i-will-find-you-be-the-1-searched-tv-show-on-google-this-year-20260730185304480 |
| 3 | 2 | will-elle-be-the-1-searched-tv-show-on-google-this-year-20260730185304496 |
| 3 | 3 | will-neagley-be-the-1-searched-tv-show-on-google-this-year-20260730185304488 |
| 5 | 2 | will-spider-noir-be-the-1-searched-tv-show-on-google-this-year-20260730185304485 |
| 3 | 2 | will-the-bear-be-the-1-searched-tv-show-on-google-this-year-20260730185304522 |
| 3 | 2 | will-the-boys-be-the-1-searched-tv-show-on-google-this-year-20260730185304513 |

### hash `c1f6413449fd` — 12 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-marco-rubio-be-the-leader-of-venezuela-end-of-2026 |
| 3 | 4 | will-nicols-maduro-be-the-leader-of-venezuela-end-of-2026 |
| 4 | 3 | will-diosdado-cabello-rondn-be-the-leader-of-venezuela-end-of-2026 |
| 3 | 4 | will-dinorah-figuera-be-the-leader-of-venezuela-end-of-2026 |
| 3 | 3 | 653ae477-7657-4937-b0b1-b62ea29295f7 |
| 6 | 4 | will-frank-donovan-be-the-leader-of-venezuela-end-of-2026 |
| 3 | 4 | will-there-be-no-head-of-state-of-venezuela-end-of-2026 |
| 3 | 4 | will-dan-caine-be-the-leader-of-venezuela-end-of-2026 |
| 4 | 3 | will-pete-hegseth-be-the-leader-of-venezuela-end-of-2026 |
| 4 | 4 | will-mara-corina-machado-be-the-leader-of-venezuela-end-of-2026 |
| 6 | 4 | will-delcy-rodrguez-be-the-leader-of-venezuela-end-of-2026 |
| 3 | 4 | will-evan-pettus-be-the-leader-of-venezuela-end-of-2026 |

### hash `03879628162c` — 11 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-alexandre-silveira-win-the-2026-minas-gerais-gubernatorial-election |
| 4 | 3 | will-tadeu-leite-win-the-2026-minas-gerais-gubernatorial-election |
| 2 | 2 | will-patrus-ananias-win-the-2026-minas-gerais-gubernatorial-election |
| 2 | 2 | will-acio-neves-win-the-2026-minas-gerais-gubernatorial-election |
| 4 | 3 | will-euclydes-pettersen-win-the-2026-minas-gerais-gubernatorial-election-20260806231233455 |
| 2 | 3 | 589c7473-a20c-490c-a9f2-d6f3e01271ca |
| 4 | 2 | will-nikolas-ferreira-win-the-2026-minas-gerais-gubernatorial-election |
| 2 | 4 | will-marcelo-aro-win-the-2026-minas-gerais-gubernatorial-election |
| 3 | 2 | will-rodrigo-pacheco-win-the-2026-minas-gerais-gubernatorial-election |
| 1 | 3 | will-alexandre-kalil-win-the-2026-minas-gerais-gubernatorial-election |
| 3 | 4 | will-cleitinho-azevedo-win-the-2026-minas-gerais-gubernatorial-election |

### hash `77bd0e1a0059` — 10 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-bitcoin-reach-190000-by-december-31-2026-936-485-627 |
| 3 | 0 | will-bitcoin-reach-100000-by-december-31-2026-571-361-361 |
| 4 | 2 | will-bitcoin-reach-1000000-by-december-31-2026-946 |
| 3 | 1 | will-bitcoin-reach-140000-by-december-31-2026-131-829-299 |
| 4 | 1 | will-bitcoin-reach-500000-by-december-31-2026-864 |
| 3 | 1 | will-bitcoin-reach-250000-by-december-31-2026-579-442 |
| 3 | 2 | will-bitcoin-reach-200000-by-december-31-2026-752-232-389 |
| 3 | 2 | will-bitcoin-reach-110000-by-december-31-2026-658-339-969 |
| 3 | 2 | will-bitcoin-reach-150000-by-december-31-2026-557-246-971 |
| 2 | 1 | will-bitcoin-reach-130000-by-december-31-2026-756-151-855 |

### hash `217d3c15d9d6` — 9 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | will-the-next-diplomatic-us-iran-meeting-be-in-egypt-by-september-30-2026-20260622185050773 |
| 5 | 4 | will-the-next-diplomatic-us-iran-meeting-be-in-italy-by-september-30-2026-20260622185050774 |
| 5 | 4 | will-the-next-diplomatic-us-iran-meeting-be-in-the-united-states-by-september-30-2026-20260622185050772 |
| 5 | 5 | will-the-next-diplomatic-us-iran-meeting-be-in-another-middle-eastnorth-africa-country-by-september-30-2026-20260622185050779 |
| 5 | 4 | will-the-next-diplomatic-us-iran-meeting-be-in-turkey-by-september-30-2026-20260622185050770 |
| 5 | 4 | will-the-next-diplomatic-us-iran-meeting-be-in-the-uae-by-september-30-2026-20260622185050765 |
| 5 | 3 | will-the-next-diplomatic-us-iran-meeting-be-in-oman-by-september-30-2026-20260622185050764 |
| 3 | 3 | will-the-next-diplomatic-us-iran-meeting-be-in-pakistan-by-september-30-2026-20260622185050777 |
| 5 | 4 | will-the-next-diplomatic-us-iran-meeting-be-in-saudi-arabia-by-september-30-2026-20260622185050766 |

### hash `e57adb0f05f8` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 1 | 2 | will-amazon-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138605 |
| 1 | 2 | will-nvidia-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138599 |
| 2 | 3 | will-tesla-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138603 |
| 1 | 2 | will-microsoft-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138600 |
| 1 | 2 | will-saudi-aramco-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138604 |
| 0 | 2 | will-broadcom-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138606 |
| 1 | 2 | will-apple-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138601 |
| 1 | 3 | will-alphabet-be-the-largest-company-in-the-world-by-market-cap-on-august-31-20260715202138602 |

### hash `33f55ffe0f8d` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-saudi-aramco-be-the-largest-company-in-the-world-by-market-cap-on-december-31-584 |
| 1 | 4 | will-spacex-be-the-largest-company-in-the-world-by-market-cap-on-december-31 |
| 0 | 2 | will-amazon-be-the-largest-company-in-the-world-by-market-cap-on-december-31-376 |
| 1 | 2 | will-tesla-be-the-largest-company-in-the-world-by-market-cap-on-december-31-139 |
| 1 | 2 | will-nvidia-be-the-largest-company-in-the-world-by-market-cap-on-december-31-244 |
| 1 | 3 | will-microsoft-be-the-largest-company-in-the-world-by-market-cap-on-december-31-481 |
| 0 | 2 | 32402b65-cba4-456e-8c1a-dfb1fbedfaa4 |
| 1 | 4 | will-alphabet-be-the-largest-company-in-the-world-by-market-cap-on-december-31-872 |

### hash `4ddfa0cac3db` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-the-communist-party-of-the-russian-federation-kprf-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 3 | 3 | will-civic-platform-gp-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 5 | 3 | will-new-people-nl-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 4 | 4 | 3ebf7a71-ac66-427c-b0f3-786ba8b45a37 |
| 4 | 3 | will-rodina-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 2 | 3 | will-united-russia-er-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 5 | 4 | will-yabloko-win-the-most-seats-in-the-next-russian-parliamentary-election |
| 2 | 2 | will-a-just-russia-for-truth-srzp-win-the-most-seats-in-the-next-russian-parliamentary-election |

### hash `deae1e62859f` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-charlie-kirk-win-the-nobel-peace-prize-in-2026 |
| 3 | 2 | will-recep-tayyip-erdoan-win-the-nobel-peace-prize-in-2026 |
| 4 | 2 | will-ahmed-al-sharaa-win-the-nobel-peace-prize-in-2026 |
| 2 | 3 | will-vladimir-putin-win-the-nobel-peace-prize-in-2026-126 |
| 2 | 3 | will-elon-musk-win-the-nobel-peace-prize-in-2026-756 |
| 2 | 1 | will-donald-trump-win-the-nobel-peace-prize-in-2026-382 |
| 2 | 4 | will-mohammed-bin-salman-win-the-nobel-peace-prize-in-2026 |
| 2 | 2 | will-volodymyr-zelensky-win-the-nobel-peace-prize-in-2026-637 |

### hash `f6f709191a6b` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-bitcoin-reach-100k-in-august-2026 |
| 2 | 2 | will-bitcoin-reach-70k-in-august-2026 |
| 2 | 2 | will-bitcoin-reach-82pt5k-in-august-2026 |
| 3 | 2 | will-bitcoin-reach-72pt5k-in-august-2026 |
| 2 | 1 | will-bitcoin-reach-77pt5k-in-august-2026 |
| 4 | 4 | will-bitcoin-reach-80k-in-august-2026 |
| 2 | 1 | will-bitcoin-reach-75k-in-august-2026 |
| 2 | 2 | will-bitcoin-reach-85k-in-august-2026 |

### hash `3fc3966423eb` — 8 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 1 | will-racing-bulls-be-the-2026-f1-constructors-champion |
| 2 | 1 | will-red-bull-racing-be-the-2026-f1-constructors-champion |
| 2 | 1 | will-haas-be-the-2026-f1-constructors-champion |
| 3 | 3 | will-williams-be-the-2026-f1-constructors-champion |
| 4 | 1 | will-alpine-be-the-2026-f1-constructors-champion |
| 3 | 1 | will-audi-be-the-2026-f1-constructors-champion |
| 3 | 1 | will-aston-martin-be-the-2026-f1-constructors-champion |
| 3 | 0 | will-cadillac-be-the-2026-f1-constructors-champion |

### hash `7af37b690c8a` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 1 | 2 | will-broadcom-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 0 | 2 | will-alphabet-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 1 | 2 | will-company-c-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 2 | 2 | will-tesla-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 2 | 3 | will-company-b-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 1 | 2 | will-saudi-aramco-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |
| 2 | 2 | will-company-d-be-the-largest-company-in-the-world-by-market-cap-on-september-30 |

### hash `cfe2e3a46d1e` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | will-bitcoin-dip-to-50k-in-august-2026 |
| 2 | 2 | will-bitcoin-dip-to-42pt5k-in-august-2026 |
| 2 | 1 | will-bitcoin-dip-to-55k-in-august-2026 |
| 2 | 3 | will-bitcoin-dip-to-52pt5k-in-august-2026 |
| 4 | 1 | will-bitcoin-dip-to-47pt5k-in-august-2026 |
| 3 | 2 | will-bitcoin-dip-to-40k-in-august-2026 |
| 4 | 2 | will-bitcoin-dip-to-45k-in-august-2026 |

### hash `1dd93a2ed328` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | will-lebron-james-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940401 |
| 4 | 1 | will-zohran-mamdani-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940431 |
| 2 | 2 | will-luigi-mangione-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940425 |
| 2 | 3 | will-cristiano-ronaldo-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940383 |
| 3 | 1 | will-billie-eilish-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940399 |
| 2 | 3 | will-nicolas-maduro-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940423 |
| 3 | 2 | will-pope-leo-xiv-be-the-1-searched-person-on-google-in-the-us-this-year-20260730192940427 |

### hash `2ce5d8e7146d` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | will-wti-dip-to-65-in-august-2026 |
| 3 | 2 | will-wti-reach-115-in-august-2026 |
| 5 | 1 | will-wti-reach-110-in-august-2026 |
| 5 | 2 | will-wti-reach-140-in-august-2026 |
| 4 | 3 | will-wti-reach-120-in-august-2026 |
| 4 | 2 | will-wti-dip-to-60-in-august-2026 |
| 4 | 3 | will-wti-reach-130-in-august-2026 |

### hash `f02ae2e8e4c5` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | will-philadelphia-eagles-win-the-2027-nfl-nfc-championship-835 |
| 2 | 2 | will-san-francisco-49ers-win-the-2027-nfl-nfc-championship-832 |
| 2 | 3 | will-minnesota-vikings-win-the-2027-nfl-nfc-championship-884 |
| 2 | 3 | will-seattle-seahawks-win-the-2027-nfl-nfc-championship-625 |
| 2 | 2 | will-washington-commanders-win-the-2027-nfl-nfc-championship-484 |
| 2 | 2 | will-green-bay-packers-win-the-2027-nfl-nfc-championship-857 |
| 2 | 3 | c6a3422a-18bc-4be5-91f6-a712287693e7 |

### hash `55446781cae9` — 7 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | will-bitcoin-dip-to-10000-by-december-31-2026-888-644-567-258-946-853-325-494-356-991 |
| 3 | 0 | will-bitcoin-dip-to-50000-by-december-31-2026-454-325-222-878-949-487-451-853-523-111 |
| 4 | 1 | will-bitcoin-dip-to-55000-by-december-31-2026-527-627-868-745-188-361-314-673-612-946-821-624-855-557-684-381-884-939-182-939-516 |
| 4 | 1 | will-bitcoin-dip-to-35000-by-december-31-2026-744-877-748-219-467-465-646-211-122-947-537-552-555-361-972-954-635-887-657-996-643 |
| 4 | 2 | will-bitcoin-dip-to-20000-by-december-31-2026-121-885-178-397-354-236-731-159-857 |
| 3 | 0 | will-bitcoin-dip-to-5000-by-december-31-2026-jy3n-991-141-345-117-196-482-674-487-176-555 |
| 4 | 2 | will-bitcoin-dip-to-30000-by-december-31-2026-971-191-116-343-999-758-299-813-237 |

### hash `310b99fcaeb4` — 6 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | us-iran-final-nuclear-deal-by-august-18-2026-20260621201255153 |
| 6 | 2 | us-iran-final-nuclear-deal-by-august-31-2026-20260621201255154 |
| 6 | 3 | us-iran-final-nuclear-deal-by-november-30-2026 |
| 5 | 4 | us-iran-final-nuclear-deal-by-october-31-2026 |
| 6 | 4 | us-iran-final-nuclear-deal-by-september-30-2026 |
| 4 | 4 | us-iran-final-nuclear-deal-by-december-31-2026-191 |

### hash `609b5829e718` — 6 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 3 | will-the-liberal-democratic-party-of-russia-ldpr-gain-the-most-seats-in-the-next-russian-parliamentary-election |
| 3 | 4 | will-rodina-gain-the-most-seats-in-the-next-russian-parliamentary-election |
| 3 | 3 | will-new-people-nl-gain-the-most-seats-in-the-next-russian-parliamentary-election |
| 3 | 4 | will-civic-platform-gp-gain-the-most-seats-in-the-next-russian-parliamentary-election |
| 3 | 2 | will-a-just-russia-for-truth-srzp-gain-the-most-seats-in-the-next-russian-parliamentary-election |
| 2 | 3 | will-united-russia-er-gain-the-most-seats-in-the-next-russian-parliamentary-election |

### hash `376db5314c9d` — 6 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-revolut-have-the-highest-ipo-market-cap-2026-963 |
| 3 | 2 | will-discord-have-the-highest-ipo-market-cap-2026-121 |
| 3 | 5 | will-waymo-have-the-highest-ipo-market-cap-2026-835 |
| 4 | 3 | will-kraken-have-the-highest-ipo-market-cap-2026-373 |
| 2 | 3 | will-shein-have-the-highest-ipo-market-cap-2026-348 |
| 4 | 3 | will-perplexity-ai-have-the-highest-ipo-market-cap-2026-546 |

### hash `2d9294ce6d47` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 4 | will-strait-of-hormuz-traffic-return-to-normal-in-december-20260702155718120 |
| 5 | 3 | will-strait-of-hormuz-traffic-not-return-to-normal-in-2026-20260702155718121 |
| 5 | 4 | will-strait-of-hormuz-traffic-return-to-normal-in-november-20260702155718119 |
| 4 | 2 | will-strait-of-hormuz-traffic-return-to-normal-in-september-20260702155718117 |
| 2 | 3 | 3173615c-dab0-4eb0-9dba-80045d685ac4 |

### hash `3366d23eebf4` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-flavio-bolsonaro-qualify-for-brazils-presidential-runoff |
| 2 | 3 | will-renan-santos-qualify-for-brazils-presidential-runoff-20260617203623448 |
| 3 | 3 | will-michelle-bolsonaro-qualify-for-brazils-presidential-runoff |
| 3 | 3 | will-luiz-incio-lula-da-silva-qualify-for-brazils-presidential-runoff |
| 3 | 5 | will-jair-bolsonaro-qualify-for-brazils-presidential-runoff |

### hash `603ed540a4e1` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-the-fed-increase-interest-rates-by-50-bps-after-the-september-2026-meeting-664 |
| 2 | 3 | will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649 |
| 3 | 1 | will-the-fed-decrease-interest-rates-by-50-bps-after-the-september-2026-meeting-863 |
| 3 | 2 | will-there-be-no-change-in-fed-interest-rates-after-the-september-2026-meeting-615 |
| 3 | 1 | will-the-fed-decrease-interest-rates-by-25-bps-after-the-september-2026-meeting-586 |

### hash `aff22e838d8c` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-there-be-at-least-5000-measles-cases-in-the-us-in-2026-436-426-345-291 |
| 2 | 3 | will-there-be-at-least-3500-measles-cases-in-the-us-in-2026 |
| 2 | 2 | will-there-be-at-least-10000-measles-cases-in-the-us-in-2026-418-668-617-245-787 |
| 1 | 1 | will-there-be-at-least-12500-measles-cases-in-the-us-in-2026-512-499-859-689 |
| 3 | 1 | will-there-be-at-least-7500-measles-cases-in-the-us-in-2026-287-181-314-511 |

### hash `27485d4e769b` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 5 | will-there-be-at-least-2500-measles-cases-in-the-uptspt-by-august-31-2026-20260728213423298 |
| 3 | 2 | will-there-be-at-least-2600-measles-cases-in-the-us-by-august-31-2026 |
| 2 | 2 | will-there-be-at-least-2700-measles-cases-in-the-us-by-august-31-2026 |
| 3 | 2 | d4c2dd86-e1aa-4fda-bb2b-ea1fe4c9df59 |
| 2 | 3 | will-there-be-at-least-2650-measles-cases-in-the-us-by-august-31-2026 |

### hash `5333f071a0e3` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-jos-carlos-aleluia-win-the-2026-bahia-gubernatorial-election |
| 3 | 3 | will-bruno-soares-reis-win-the-2026-bahia-gubernatorial-election |
| 2 | 3 | will-joo-roma-win-the-2026-bahia-gubernatorial-election |
| 3 | 3 | will-rui-costa-win-the-2026-bahia-gubernatorial-election |
| 2 | 3 | will-kleber-rosa-win-the-2026-bahia-gubernatorial-election |

### hash `aef6b5c5a5f9` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-the-fed-decrease-interest-rates-by-25-bps-after-the-october-2026-meeting-20260617190324030 |
| 2 | 0 | will-the-fed-increase-interest-rates-by-50-bps-after-the-october-2026-meeting-20260617190324033 |
| 3 | 2 | will-the-fed-increase-interest-rates-by-25-bps-after-the-october-2026-meeting-20260617190324032 |
| 3 | 1 | will-the-fed-decrease-interest-rates-by-50-bps-after-the-october-2026-meeting-20260617190324029 |
| 1 | 0 | will-there-be-no-change-in-fed-interest-rates-after-the-october-2026-meeting-20260617190324031 |

### hash `73eca2b61cfe` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-anna-karin-hatt-be-the-next-prime-minister-of-sweden |
| 3 | 2 | will-amanda-lind-be-the-next-prime-minister-of-sweden |
| 2 | 2 | will-daniel-helldn-be-the-next-prime-minister-of-sweden |
| 2 | 2 | will-jimmie-kesson-be-the-next-prime-minister-of-sweden |
| 2 | 3 | will-simona-mohamsson-be-the-next-prime-minister-of-sweden |

### hash `f1e7e8b4c4e6` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 6 | 5 | israel-x-iran-ceasefire-continues-through-december-31 |
| 4 | 3 | israel-x-iran-ceasefire-continues-through-august-15-20260716224448969-246-815-987-693 |
| 7 | 4 | israel-x-iran-ceasefire-continues-through-september-30 |
| 6 | 3 | israel-x-iran-ceasefire-continues-through-august-31-20260716224448970-754-896-823 |
| 4 | 3 | israel-x-iran-ceasefire-continues-through-october-31 |

### hash `283b82bb4b3d` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-flvio-bolsonaro-win-the-first-round-of-the-2026-brazilian-presidential-election-by-at-least-10-148 |
| 3 | 4 | will-renan-santos-win-the-first-round-of-the-2026-brazilian-presidential-election |
| 3 | 3 | will-luiz-incio-lula-da-silva-win-the-first-round-of-the-2026-brazilian-presidential-election-by-at-least-15-722 |
| 3 | 3 | will-flvio-bolsonaro-win-the-first-round-of-the-2026-brazilian-presidential-election-by-less-than-5-183 |
| 4 | 4 | will-luiz-incio-lula-da-silva-win-the-first-round-of-the-2026-brazilian-presidential-election-by-1015-995 |

### hash `0f20fc898046` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-china-have-an-ebola-case-in-2026 |
| 3 | 3 | will-the-united-states-have-an-ebola-case-in-2026 |
| 3 | 3 | will-south-sudan-have-an-ebola-case-in-2026 |
| 2 | 3 | will-kenya-have-an-ebola-case-in-2026 |
| 4 | 3 | will-canada-have-an-ebola-case-in-2026 |

### hash `fdb210318474` — 5 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 1 | will-the-fed-decrease-interest-rates-by-50-bps-after-the-december-2026-meeting-20260729232808633 |
| 5 | 1 | will-there-be-no-change-in-fed-interest-rates-after-the-december-2026-meeting-20260729232808635 |
| 4 | 0 | will-the-fed-increase-interest-rates-by-50-bps-after-the-december-2026-meeting-20260729232808637 |
| 2 | 2 | will-the-fed-decrease-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808634 |
| 1 | 1 | will-the-fed-increase-interest-rates-by-25-bps-after-the-december-2026-meeting-20260729232808636 |

### hash `64860566eec5` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 4 | putin-out-as-president-of-russia-by-august-31-2026 |
| 3 | 3 | putin-out-as-president-of-russia-by-june-30-2027 |
| 4 | 4 | putin-out-before-2027-346 |
| 4 | 4 | putin-out-as-president-of-russia-by-september-30-2026 |

### hash `b9f70abd62e4` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | f440f825-b763-4e44-8059-1a9d4eec75db |
| 2 | 4 | will-roberto-cludio-win-the-2026-cear-gubernatorial-election |
| 1 | 2 | will-camilo-santana-win-the-2026-cear-gubernatorial-election |
| 1 | 3 | will-capito-wagner-win-the-2026-cear-gubernatorial-election |

### hash `8197538ae4c0` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-bitcoin-reach-76k-august-10-16-2026 |
| 2 | 2 | will-bitcoin-reach-72k-august-10-16-2026 |
| 3 | 1 | will-bitcoin-reach-74k-august-10-16-2026 |
| 2 | 2 | will-bitcoin-reach-78k-august-10-16-2026 |

### hash `1d06ae06273c` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | will-fernando-haddad-win-the-2026-so-paulo-gubernatorial-election |
| 2 | 3 | will-tarcsio-de-freitas-win-the-2026-so-paulo-gubernatorial-election |
| 3 | 3 | will-kim-kataguiri-win-the-2026-so-paulo-gubernatorial-election |
| 1 | 3 | will-erika-hilton-win-the-2026-so-paulo-gubernatorial-election |

### hash `ca684e9e21a6` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | will-meituan-have-the-best-ai-model-at-the-end-of-december-2026 |
| 4 | 2 | will-mistral-have-the-best-ai-model-at-the-end-of-december-2026 |
| 6 | 4 | will-baidu-have-the-best-ai-model-at-the-end-of-december-2026 |
| 5 | 2 | will-microsoft-have-the-best-ai-model-at-the-end-of-december-2026 |

### hash `2852f73096e4` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-ethereum-reach-7500-by-december-31-2026 |
| 3 | 2 | will-ethereum-reach-7000-by-december-31-2026 |
| 3 | 2 | will-ethereum-reach-10000-by-december-31-2026 |
| 2 | 2 | will-ethereum-reach-8000-by-december-31-2026 |

### hash `fa6468ca85b4` — 4 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | d020b798-31b5-41ae-a9ec-336f32156775 |
| 2 | 1 | will-toby-wallace-be-the-1-searched-actor-on-google-this-year-20260717224316153 |
| 4 | 3 | will-ioan-gruffudd-be-the-1-searched-actor-on-google-this-year-20260717224316145 |
| 2 | 2 | will-channing-tatum-be-the-1-searched-actor-on-google-this-year-20260717224316144 |

### hash `8227f6aee16c` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-the-uptspt-weekly-flu-hospitalization-rate-per-100000-in-week-31-be-greater-than-0pt1-1786098036064 |
| 3 | 3 | will-the-uptspt-weekly-flu-hospitalization-rate-per-100000-in-week-31-be-less-than-0pt1-1786098036062 |
| 3 | 2 | will-the-uptspt-weekly-flu-hospitalization-rate-per-100000-in-week-31-be-exactly-0pt1-1786098036063 |

### hash `944a8f58aa31` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 4 | mojtaba-khamenei-seen-in-public-by-september-30-944 |
| 4 | 2 | mojtaba-khamenei-seen-in-public-by-august-31-223 |
| 4 | 4 | mojtaba-khamenei-seen-in-public-by-december-31 |

### hash `c7d31f12e563` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | will-los-angeles-chargers-win-the-2027-nfl-afc-championship-786 |
| 2 | 3 | will-buffalo-bills-win-the-2027-nfl-afc-championship-542 |
| 2 | 3 | will-baltimore-ravens-win-the-2027-nfl-afc-championship-498 |

### hash `f2d9855fbb68` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | will-ethereum-dip-to-800-by-december-31-2026-568 |
| 3 | 3 | will-ethereum-dip-to-1000-by-december-31-2026-273-175 |
| 4 | 2 | will-ethereum-dip-to-1500-by-december-31-2026-865-787 |

### hash `124b16de3248` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 3 | iran-leadership-change-by-october-31 |
| 4 | 2 | iran-leadership-change-by-december-31-974-976-658-482-568-685-996-469-827 |
| 4 | 3 | iran-leadership-change-by-august-31-669-893 |

### hash `f34f45b6b746` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 7 | 3 | 2026-balance-of-power-r-senate-r-house-537 |
| 9 | 2 | 2026-balance-of-power-d-senate-r-house-692 |
| 5 | 4 | 2026-balance-of-power-other-131 |

### hash `80d8ea766b7e` — 3 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | israel-withdraws-from-lebanon-by-september-30-2026 |
| 4 | 3 | israel-withdraws-from-lebanon-by-august-31-2026 |
| 4 | 3 | israel-withdraws-from-lebanon-by-december-31-2026 |

### hash `14b25088963b` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | will-jay-collins-be-the-republican-nominee-for-florida-governor |
| 2 | 2 | will-james-fishback-be-the-republican-nominee-for-florida-governor |

### hash `2044967b3b1b` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 2 | will-bitcoin-reach-75000-by-december-31-2026-from-june-8 |
| 2 | 2 | will-bitcoin-reach-70000-by-december-31-2026-from-june-8 |

### hash `5fc2a5eba408` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 3 | us-iran-hormuz-agreement-by-august-31-20260804222025507-868-993 |
| 5 | 4 | iran-oman-hormuz-agreement-by-september-30 |

### hash `20a04619c33c` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 2 | will-anthropics-valuation-hit-high-1pt5t-by-december-31-797 |
| 5 | 5 | will-anthropics-valuation-hit-high-4pt0t-by-december-31 |

### hash `d60f66146b93` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | will-the-democratic-party-control-the-senate-after-the-2026-midterm-elections |
| 7 | 3 | will-the-republican-party-control-the-senate-after-the-2026-midterm-elections |

### hash `7f0d9069b6d0` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 4 | will-the-democratic-party-control-the-house-after-the-2026-midterm-elections |
| 4 | 4 | will-the-republican-party-control-the-house-after-the-2026-midterm-elections |

### hash `504e2c92c7fb` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 2 | will-farsi-hengam-hormuz-or-kharg-island-no-longer-be-under-iranian-control-by-september-30-2026-20260804165426111 |
| 4 | 5 | will-farsi-hengam-hormuz-or-kharg-island-no-longer-be-under-iranian-control-by-august-31-2026-20260804165426110 |

### hash `3223acc7af0e` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 2 | bitcoin-all-time-high-by-december-31-2026 |
| 3 | 2 | bitcoin-all-time-high-by-september-30-2026 |

### hash `eafd5b41ca24` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 3 | russia-x-ukraine-ceasefire-agreement-by-october-31-2026 |
| 5 | 4 | russia-x-ukraine-ceasefire-agreement-by-august-31-2026 |

### hash `2b7218197ca6` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 5 | 3 | iran-charges-hormuz-fees-by-august-31-20260625175039062-177 |
| 5 | 2 | iran-charges-hormuz-fees-by-december-31-20260706203029175-553 |

### hash `19227efc3bfc` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 1 | will-crude-oil-reach-a-new-all-time-high-by-december-31 |
| 3 | 2 | will-crude-oil-reach-a-new-all-time-high-by-september-30 |

### hash `df96f302b387` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 1 | 1 | will-nithya-raman-win-the-2026-los-angeles-mayoral-election-876 |
| 2 | 2 | will-karen-bass-win-the-2026-los-angeles-mayoral-election |

### hash `b71f0dfaece7` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 2 | 3 | will-gukesh-dommaraju-win-the-2026-world-chess-championship |
| 2 | 3 | will-javokhir-sindarov-win-the-2026-world-chess-championship |

### hash `6633f2893649` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 4 | 4 | fed-rate-hike-by-october-2026-meeting |
| 2 | 3 | fed-rate-hike-by-september-2026-meeting |

### hash `70149efff94d` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-jorginho-mello-win-the-governor-of-santa-catarina-election-20260609164311690 |
| 1 | 3 | will-marcelo-brigadeiro-win-the-governor-of-santa-catarina-election-20260609164311691 |

### hash `aa8e3ee6e707` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 3 | will-oregon-ducks-win-the-2027-cfp-national-championship |
| 3 | 1 | will-notre-dame-fighting-irish-win-the-2027-cfp-national-championship |

### hash `7098aa56dc92` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 3 | 1 | bab-el-mandeb-strait-effectively-closed-by-august-31 |
| 3 | 2 | bab-el-mandeb-strait-effectively-closed-by-december-31-983-117 |

### hash `e8d75561b6df` — 2 mercados

| pegadinhas | ambiguidades | mercado |
| ---: | ---: | --- |
| 7 | 3 | russia-x-ukraine-ceasefire-by-december-31-2026 |
| 8 | 4 | russia-x-ukraine-ceasefire-by-october-31-2026 |

