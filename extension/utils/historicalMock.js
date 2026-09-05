/**
 * Geçmiş Maçları Simüle Eden Mock (Test) Servisi
 * Nesine'nin açık bir geçmiş maç API'si bulunmadığından,
 * UI testleri için kurallara uygun (Yıl -> Ay -> Maç) mock veri üretir.
 */

export function getHistoricalMatches(homeTeam, awayTeam) {
    return {
        "2025": {
            "Mart": [
                {
                    "nesineMatchId": "5000001",
                    "home": awayTeam,
                    "away": homeTeam,
                    "date": "2025-03-16",
                    "score": "1 - 1",
                    "hasOdds": true,
                    "historical": true,
                    "markets": {
                        "MAÇ SONUCU": {
                            "Maç Sonucu": { "1": "2.40", "X": "3.10", "2": "2.55" }
                        },
                        "TOPLAM GOL": {
                            "Toplam Gol 2.5 Alt/Üst": { "Alt": "1.70", "Üst": "1.85" }
                        }
                    }
                }
            ]
        },
        "2024": {
            "Ağustos": [
                {
                    "nesineMatchId": "4000001",
                    "home": homeTeam,
                    "away": awayTeam,
                    "date": "2024-08-15",
                    "score": "2 - 0",
                    "hasOdds": true,
                    "historical": true,
                    "markets": {
                        "MAÇ SONUCU": {
                            "Maç Sonucu": { "1": "2.10", "X": "3.20", "2": "2.90" }
                        },
                        "GOL": {
                            "Karşılıklı Gol": { "Var": "1.65", "Yok": "1.90" }
                        }
                    }
                }
            ]
        },
        "2021": {
            "Ağustos": [
                {
                    "nesineMatchId": "1000001",
                    "home": homeTeam,
                    "away": awayTeam,
                    "date": "2021-08-15",
                    "score": "0 - 0",
                    "hasOdds": false,
                    "historical": true,
                    "markets": {}
                }
            ],
            "Nisan": [
                {
                    "nesineMatchId": "1000002",
                    "home": awayTeam,
                    "away": homeTeam,
                    "date": "2021-04-02",
                    "score": "1 - 2",
                    "hasOdds": true,
                    "historical": true,
                    "markets": {
                        "MAÇ SONUCU": {
                            "Maç Sonucu": { "1": "2.80", "X": "3.10", "2": "2.25" }
                        }
                    }
                }
            ]
        }
    };
}
