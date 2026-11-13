# Simulated comparison (model output, not measurement)

Seeds per scenario: 30. Prices are hypothetical (prereg.json). Values are means over seeds unless noted.

## baseline

{} | readers=200 keys=8 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5        113.13          0.00        14.792          0.00             0             0             0           193           247         100.0
browser-ttl              604.1          8.63          0.00         2.529          6.63          4965             0             0             1           225           7.5
cdn-ttl                   80.6          9.72          0.00         1.752          7.88          4974             0             0             1            59           7.6
cdn-purge                 17.6         10.56          0.00         2.730          0.60           298             0             0            37            48           8.0
p2p-gossip                44.1          2.80          7.16         3.693          4.65         59618          8367             0             1            90           2.5
nodex-coupled            136.7          8.67         41.66         4.458          3.00          4965             0             0             2           175           7.6
nodex-detached            98.9          2.80          9.01         3.858          1.74          3054             0             0             1            88           2.4
nodex-shipped             74.2          2.87          6.65         3.932          3.15          4850             0             0             2           148           2.4
nodex-edgebg             241.3          3.69          6.12         5.183          3.34          4949             0             0             1           154           2.4
nodex-pulledge           212.0          3.53          6.12         4.919          2.90          5017             0             0             1           198           2.4
nodex-pullbg             749.7          3.41          6.05         5.860          2.89          4622             0             0             1           233           2.4
nodex-pull               630.8          3.30          6.07         5.495          2.40          4743             0             0             1           237           2.4
```

## big-audience

{"readers":1000,"keys":2} | readers=1000 keys=2 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.3        113.12          0.00        14.791          0.00             0             0             0           193           247         100.0
browser-ttl              604.0          8.99          0.00         2.559          6.93          4986             0             0             1           225           7.8
cdn-ttl                    4.3          9.24          0.00         1.509          8.61          4991             0             0             1            48           7.9
cdn-purge                  1.0         10.01          0.00         2.634          0.62           299             0             0            37            48           8.3
p2p-gossip                44.3          2.81          7.51         3.705          4.86         59229         43738             0             1            91           2.5
nodex-coupled            126.4          8.01         44.94         4.383          3.19          5238             0             0             2           169           7.0
nodex-detached            57.6          2.80         10.22         3.744          1.28          4290             0             0             1            89           2.5
nodex-shipped             13.3          2.80          7.11         3.745          3.52          4945             0             0            25           128           2.4
nodex-edgebg              21.1          3.55          6.47         4.552          3.66          4933             0             0             1           101           2.4
nodex-pulledge            20.5          3.40          6.49         4.359          3.23          4961             0             0             1           113           2.5
nodex-pullbg             750.9          3.43          6.41         5.876          3.01          4929             0             0             1           234           2.4
nodex-pull               631.8          3.32          6.43         5.510          2.50          4924             0             0             1           239           2.4
```

## heavy-payload

{"payloadBytes":1048576} | readers=200 keys=8 payload=1048576B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5       1801.06          0.00       154.904          0.00             0             0             0           390           444         100.0
browser-ttl              604.1        135.08          0.00        13.025          6.63          4965             0             0             1           369           7.5
cdn-ttl                   80.6        151.52          0.00        13.523          7.88          4974             0             0             1           243           7.6
cdn-purge                 17.6        159.86          0.00        15.123          0.60           298             0             0            37           244           8.0
p2p-gossip                44.1         44.16        113.44         7.126          4.65         59618          8367             0             1           567           2.5
nodex-coupled            136.7        136.80        660.36        15.094          3.00          4965             0             0             2           591           7.6
nodex-detached            98.9         43.62        102.34         7.246          1.74          3054             0             0             1           543           2.4
nodex-shipped             74.2         43.05        100.16         7.267          3.15          4850             0             0             2           565           2.4
nodex-edgebg             241.3         44.49         97.83         8.570          3.34          4949             0             0             1           530           2.4
nodex-pulledge           212.0         44.66         97.77         8.332          2.90          5017             0             0             1           535           2.4
nodex-pullbg             749.7         44.30         96.73         9.255          2.89          4622             0             0             1           553           2.4
nodex-pull               630.8         44.24         97.08         8.893          2.40          4743             0             0             1           611           2.4
```

## small-payload

{"payloadBytes":2048} | readers=200 keys=8 payload=2048B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5          4.12          0.00         5.743          0.00             0             0             0           180           234         100.0
browser-ttl              604.1          0.47          0.00         1.851          6.63          4965             0             0             1           222           7.5
cdn-ttl                   80.6          0.56          0.00         0.992          7.88          4974             0             0             1            48           7.6
cdn-purge                 17.6          0.92          0.00         1.929          0.60           298             0             0            36            47           8.0
p2p-gossip                44.1          0.13          0.29         3.471          4.65         59618          8367             0             1            58           2.5
nodex-coupled            136.7          0.39          1.70         3.771          3.00          4965             0             0             2           162           7.6
nodex-detached            98.9          0.17          2.98         3.639          1.74          3054             0             0             1            56           2.4
nodex-shipped             74.2          0.28          0.61         3.717          3.15          4850             0             0             2           123           2.4
nodex-edgebg             241.3          1.05          0.20         4.964          3.34          4949             0             0             1           151           2.4
nodex-pulledge           212.0          0.88          0.20         4.698          2.90          5017             0             0             1           195           2.4
nodex-pullbg             749.7          0.76          0.19         5.641          2.89          4622             0             0             1           225           2.4
nodex-pull               630.8          0.66          0.20         5.275          2.40          4743             0             0             1           231           2.4
```

## high-churn

{"sessionMeanMs":30000} | readers=200 keys=8 payload=65536B write~30000ms session~30000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1801.6        113.20          0.00        14.801          0.00             0             0             0           193           247         100.0
browser-ttl              641.6         14.37          0.00         3.117          6.38          4977             0             0             1           228          12.6
cdn-ttl                   81.3         15.92          0.00         2.332          7.84          4990             0             0             1            60          13.1
cdn-purge                 17.8         16.67          0.00         3.239          0.60           291             0             0            38            53          13.4
p2p-gossip               146.8          9.31          5.75        11.175          4.02         59902          4834             0             1           180           8.1
nodex-coupled            238.9         15.15         41.82        11.936          2.89          4923             0             0            35           209          13.3
nodex-detached           206.7          9.41          7.81        11.363          1.75          4180             0             0             1           186           8.2
nodex-shipped            133.2          9.53          6.08        11.403          3.10          4893             0             0            35           170           8.2
nodex-edgebg             250.0         10.22          5.58        12.418          3.22          4936             0             0             1           172           8.2
nodex-pulledge           227.5         10.10          5.57        12.181          2.83          4817             0             0             1           203           8.2
nodex-pullbg             784.2          9.92          5.50        13.138          2.72          4810             0             0             1           236           8.2
nodex-pull               668.8          9.81          5.54        12.783          2.35          4855             0             0             1           238           8.2
```

## hot-writes

{"writeMeanMs":3000} | readers=200 keys=8 payload=65536B write~3000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.4        113.13          0.00        14.791          0.00             0             0             0           193           247         100.0
browser-ttl              604.1         33.09          0.00         4.559         40.51          4989             0             0             1           234          29.2
cdn-ttl                   80.5         40.84          0.00         4.335         48.93          4996             0             0             1            61          32.3
cdn-purge                129.5         63.64          0.00         7.472          5.15           298             0             0            43           174          48.8
p2p-gossip               171.5         10.87         39.46         4.772         24.72         30280          2553             0             2           190           9.5
nodex-coupled            199.6         12.66         51.79         5.005         22.68          5090             0             0            74           200          11.1
nodex-detached           227.2         12.36         45.99         5.063         14.74          4011             0             0             8           200          10.9
nodex-shipped            108.6         11.39         41.49         4.845         24.29          4975             0             0            51           169           9.9
nodex-edgebg             251.9         13.53         36.66         6.267         22.18          4987             0             0             3           236          11.0
nodex-pulledge           229.7         13.43         36.89         6.086         20.87          4953             0             0            29           240          11.0
nodex-pullbg             933.9         12.99         34.24         7.235         17.12          4929             0             0             2           306          10.8
nodex-pull               856.5         12.97         34.36         7.001         15.69          4936             0             0             6           307          10.8
```

## long-tail

{"keys":200,"zipf":0.8} | readers=200 keys=200 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5        113.13          0.00        14.792          0.00             0             0             0           193           247         100.0
browser-ttl              604.1          8.36          0.00         2.506          6.37          4941             0             0             1           225           7.3
cdn-ttl                  412.2         13.88          0.00         3.022          6.82          4957             0             0             1           210           7.3
cdn-purge                100.5         14.99          0.00         3.347          0.54           295             0             0            37           150           7.7
p2p-gossip                84.5          5.36          4.09         4.020          4.38         58883          7827             0             1           104           4.7
nodex-coupled            338.7         21.48         22.31         6.120          2.63          4909             0             0             1           221          18.8
nodex-detached           498.7          5.42          4.67         5.268          2.65          4849             0             0             1           136           4.4
nodex-shipped            327.4          5.58          3.80         5.107          2.64          4761             0             0             1           210           4.4
nodex-edgebg             613.7          6.23          3.53         6.449          2.89          4969             0             0             1           217           4.4
nodex-pulledge           512.8          6.04          3.53         5.999          2.46          4777             0             0             1           226           4.4
nodex-pullbg             753.0          5.66          3.51         6.051          2.77          4668             0             0             1           227           4.4
nodex-pull               630.0          5.57          3.52         5.674          2.33          4789             0             0             1           232           4.4
```

## adversarial

{"adversaryFrac":0.3,"invalidationLoss":0.5,"purgeLoss":0.05,"edgeStickProb":0.1,"badClockFrac":0.02} | readers=200 keys=8 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5        113.13          0.00        14.792          0.00             0             0             0           193           247         100.0
browser-ttl              604.1          8.63          0.00         2.529          6.63          4965             0             0             1           225           7.5
cdn-ttl                   72.6          9.54          0.00         1.714          9.65         67807          6715             0             1            58           7.5
cdn-purge                 16.8         10.31          0.00         2.706          3.46         82016         19247             0            37            48           7.8
p2p-gossip                55.1          3.49          3.84         3.784         35.59        294098        252880             0             1            84           3.1
nodex-coupled            237.9         15.08         38.24         5.294          5.36         24471            64             0             2           298          13.2
nodex-detached           249.5          5.28         11.19         4.515          3.22          4931             0             0             1           130           4.5
nodex-shipped            194.4          5.59          4.03         4.657          5.58          4968             0             0             2           303           4.6
nodex-edgebg             302.1          6.28          3.38         5.569          6.10          4990             0             0             1           209           4.7
nodex-pulledge           278.9          6.09          3.37         5.315          5.04          4973             0             0             1           229           4.7
nodex-pullbg             797.1          5.98          3.34         6.216          5.37          4971             0             0             1           241           4.7
nodex-pull               675.3          5.84          3.35         5.839          4.44          4952             0             0             1           256           4.7
```

## clock-replay

{"adversaryFrac":0.5,"invalidationLoss":1,"badClockFrac":0.3} | readers=200 keys=8 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5        113.13          0.00        14.792          0.00             0             0             0           193           247         100.0
browser-ttl              604.1          8.63          0.00         2.529          6.63          4965             0             0             1           225           7.5
cdn-ttl                   80.6          9.72          0.00         1.752          7.88          4974             0             0             1            59           7.6
cdn-purge                 17.6         10.56          0.00         2.730          0.60           298             0             0            37            48           8.0
p2p-gossip                28.0          1.77          3.19         3.559         76.41        298018        642038             0             1             2           1.6
nodex-coupled            599.0         37.98         35.06         8.278          7.39         34878          4977             0            85           334          33.3
nodex-detached           388.5          6.26         10.43         5.013          6.23          5004             0             0             1           170           5.3
nodex-shipped            228.4          6.70          2.75         4.894          8.46          5015             0             0             2           321           5.6
nodex-edgebg             323.0          7.38          2.17         5.710          9.03          4990             0             0             1           230           5.7
nodex-pulledge           299.9          7.17          2.09         5.452          7.33          5009             0             0             1           248           5.7
nodex-pullbg             806.7          7.09          2.11         6.337          7.96          4971             0             0             1           247           5.7
nodex-pull               682.3          6.93          2.08         5.950          6.64          4951             0             0             1           289           5.6
```

## legacy-poll

{"pollSteadyMs":500,"pollDiscoveryMs":500} | readers=200 keys=8 payload=65536B write~30000ms session~300000ms

```
arm               originReq/rh  billedMiB/rh    peerMiB/rh       $/1k rh        stale%   maxStale ms      viol>d+e          mono        p50 ms        p95 ms infraPayload%
origin-only             1800.5        113.13          0.00        14.792          0.00             0             0             0           193           247         100.0
browser-ttl              604.1          8.63          0.00         2.529          6.63          4965             0             0             1           225           7.5
cdn-ttl                   80.6          9.72          0.00         1.752          7.88          4974             0             0             1            59           7.6
cdn-purge                 17.6         10.56          0.00         2.730          0.60           298             0             0            37            48           8.0
p2p-gossip                44.1          2.80          7.16        36.365          4.65         59618          8367             0             1            90           2.5
nodex-coupled            136.7          8.67         41.66        37.129          3.00          4965             0             0             2           175           7.6
nodex-detached            98.9          2.80          9.01        36.529          1.74          3054             0             0             1            88           2.4
nodex-shipped             74.2          2.87          6.65        36.604          3.15          4850             0             0             2           148           2.4
nodex-edgebg             241.3          3.69          6.12        37.855          3.34          4949             0             0             1           154           2.4
nodex-pulledge           212.0          3.53          6.12        37.590          2.90          5017             0             0             1           198           2.4
nodex-pullbg             749.7          3.41          6.05        38.532          2.89          4622             0             0             1           233           2.4
nodex-pull               630.8          3.30          6.07        38.166          2.40          4743             0             0             1           237           2.4
```

## Pre-registered hypothesis checks

```
PASS H1a  SAFETY: zero admitted reads older than delta+eps (6 s), in every scenario incl. replay adversaries, lost invalidations, wrong clocks
     worst seed: 0 (baseline, seed 1)
PASS H1b  SAFETY: zero version rollbacks within a session
     worst seed: 0 (baseline, seed 1)
PASS H1c  ABLATION: the same mesh WITHOUT the signed validity window does violate the bound (the oracle has teeth)
     worst seed: 179 (baseline, seed 5)
PASS H1d  FINDING: the proof check as coded (raw Date.now, publisher-proof.ts:80) is breakable by replay against slow-clock readers
     worst seed: 58 (clock-replay, seed 24)
PASS H1e  BASELINE: long-TTL + purge violates the bound as soon as purges are lost (5%)
     worst seed: 96 (adversarial, seed 19)
PASS H1f  BASELINE: TTL=delta CDN violates the bound under serve-stale-on-error (10% failed revalidations); it is safe only while the edge is trusted and healthy
     worst seed: 91 (adversarial, seed 10)
PASS H2a  EFFICIENCY: detached proofs cut billed infrastructure bytes to <= 40% of a TTL=delta CDN at the same staleness bound
     worst seed: 0.3818 (big-audience, seed 14)
PASS H2b  EFFICIENCY under stress: still <= 75% with 30 s mean sessions or 30% hostile peers
     worst seed: 0.6229 (high-churn, seed 21)
PASS H2c  LATENCY: modelled p95 read latency <= 150 ms (no SLO bought with dropped requests)
     worst seed: 96.3845 (big-audience, seed 24)
PASS H2d  USER COST: peer upload+control <= 16 MiB per reader-hour at 64 KiB payloads
     worst seed: 13.1225 (big-audience, seed 24)
FAIL H3a  CUT: the proof-per-GET design in the repo saves < 30% of billed bytes vs a TTL=delta CDN
     worst seed: 0.6663 (big-audience, seed 24)
PASS H3b  CUT: and it moves >= 3x more bytes onto reader uplinks than the detached design
     worst seed: 3.4349 (big-audience, seed 24)
PASS H4a  KILL ZONE: at hypothetical prices Nodex costs MORE than the TTL CDN for <= 64 KiB snapshots, long tails and short sessions; it must self-disable there
     worst seed: 1.6872 (long-tail, seed 28)
PASS H4b  WIN ZONE: modelled cost <= 70% of the TTL CDN once payload reaches 1 MiB per version
     worst seed: 0.5809 (heavy-payload, seed 15)
PASS H5  NOT CLAIMED: Nodex does not reduce origin REQUESTS below a TTL=delta CDN (origin offload vs CDN is not the contribution)
     worst seed: 1.1563 (baseline, seed 23)
PASS H1a-pull  SHIPPED PATH SAFETY: zero admitted reads older than delta+eps under the pull-renew design in every scenario
     worst seed: 0 (baseline, seed 1)
PASS H1b-pull  SHIPPED PATH SAFETY: zero version rollbacks under pull-renew
     worst seed: 0 (baseline, seed 1)
EXPLORATORY FAIL H2a-pull  SHIPPED PATH EFFICIENCY: pull-renew billed infrastructure bytes <= 40% of a TTL=delta CDN
     worst seed: 0.4642 (big-audience, seed 14)
EXPLORATORY PASS H2b-pull  SHIPPED PATH stress: still <= 75% with 30 s sessions or 30% hostile peers
     worst seed: 0.6585 (adversarial, seed 20)
EXPLORATORY FAIL H2c-pull  SHIPPED PATH LATENCY: p95 <= 150 ms
     worst seed: 252.2923 (big-audience, seed 24)
EXPLORATORY PASS H2d-pull  SHIPPED PATH USER COST: peer upload+control <= 16 MiB per reader-hour
     worst seed: 9.1565 (big-audience, seed 24)
EXPLORATORY PASS H4a-pull  SHIPPED PATH KILL ZONE: still costs more than the CDN for small payloads, long tails and short sessions
     worst seed: 1.8036 (long-tail, seed 25)
EXPLORATORY FAIL H4b-pull  SHIPPED PATH WIN ZONE: cost <= 70% of the CDN at 1 MiB per version
     worst seed: 0.7245 (heavy-payload, seed 14)
EXPLORATORY PASS H5-pull  SHIPPED PATH NOT CLAIMED: origin requests are not below a TTL=delta CDN
     worst seed: 7.6843 (baseline, seed 1)
PASS H1a-pullbg  PULL + BACKGROUND RENEWAL: SAFETY: zero admitted reads older than delta+eps (6 s), in every scenario incl. replay adversaries, lost invalidations, wrong clocks
     worst seed: 0 (baseline, seed 1)
PASS H1b-pullbg  PULL + BACKGROUND RENEWAL: SAFETY: zero version rollbacks within a session
     worst seed: 0 (baseline, seed 1)
EXPLORATORY FAIL H2a-pullbg  PULL + BACKGROUND RENEWAL: EFFICIENCY: detached proofs cut billed infrastructure bytes to <= 40% of a TTL=delta CDN at the same staleness bound
     worst seed: 0.4842 (big-audience, seed 14)
EXPLORATORY PASS H2b-pullbg  PULL + BACKGROUND RENEWAL: EFFICIENCY under stress: still <= 75% with 30 s mean sessions or 30% hostile peers
     worst seed: 0.6666 (adversarial, seed 20)
EXPLORATORY FAIL H2c-pullbg  PULL + BACKGROUND RENEWAL: LATENCY: modelled p95 read latency <= 150 ms (no SLO bought with dropped requests)
     worst seed: 246.1189 (big-audience, seed 24)
EXPLORATORY PASS H2d-pullbg  PULL + BACKGROUND RENEWAL: USER COST: peer upload+control <= 16 MiB per reader-hour at 64 KiB payloads
     worst seed: 9.1323 (big-audience, seed 24)
EXPLORATORY FAIL H4b-pullbg  PULL + BACKGROUND RENEWAL: WIN ZONE: modelled cost <= 70% of the TTL CDN once payload reaches 1 MiB per version
     worst seed: 0.7455 (heavy-payload, seed 14)
EXPLORATORY PASS H5-pullbg  PULL + BACKGROUND RENEWAL: NOT CLAIMED: Nodex does not reduce origin REQUESTS below a TTL=delta CDN (origin offload vs CDN is not the contribution)
     worst seed: 9.1332 (baseline, seed 1)
PASS H1a-pulledge  PULL VIA EDGE (proof TTL 1 s): SAFETY: zero admitted reads older than delta+eps (6 s), in every scenario incl. replay adversaries, lost invalidations, wrong clocks
     worst seed: 0 (baseline, seed 1)
PASS H1b-pulledge  PULL VIA EDGE (proof TTL 1 s): SAFETY: zero version rollbacks within a session
     worst seed: 0 (baseline, seed 1)
EXPLORATORY FAIL H2a-pulledge  PULL VIA EDGE (proof TTL 1 s): EFFICIENCY: detached proofs cut billed infrastructure bytes to <= 40% of a TTL=delta CDN at the same staleness bound
     worst seed: 0.4756 (big-audience, seed 14)
EXPLORATORY PASS H2b-pulledge  PULL VIA EDGE (proof TTL 1 s): EFFICIENCY under stress: still <= 75% with 30 s mean sessions or 30% hostile peers
     worst seed: 0.6833 (adversarial, seed 20)
EXPLORATORY FAIL H2c-pulledge  PULL VIA EDGE (proof TTL 1 s): LATENCY: modelled p95 read latency <= 150 ms (no SLO bought with dropped requests)
     worst seed: 202.5553 (baseline, seed 30)
EXPLORATORY PASS H2d-pulledge  PULL VIA EDGE (proof TTL 1 s): USER COST: peer upload+control <= 16 MiB per reader-hour at 64 KiB payloads
     worst seed: 9.2612 (big-audience, seed 24)
EXPLORATORY PASS H4b-pulledge  PULL VIA EDGE (proof TTL 1 s): WIN ZONE: modelled cost <= 70% of the TTL CDN once payload reaches 1 MiB per version
     worst seed: 0.6698 (heavy-payload, seed 14)
EXPLORATORY PASS H5-pulledge  PULL VIA EDGE (proof TTL 1 s): NOT CLAIMED: Nodex does not reduce origin REQUESTS below a TTL=delta CDN (origin offload vs CDN is not the contribution)
     worst seed: 2.56 (baseline, seed 23)
PASS H1a-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: SAFETY: zero admitted reads older than delta+eps (6 s), in every scenario incl. replay adversaries, lost invalidations, wrong clocks
     worst seed: 0 (baseline, seed 1)
PASS H1b-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: SAFETY: zero version rollbacks within a session
     worst seed: 0 (baseline, seed 1)
EXPLORATORY FAIL H2a-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: EFFICIENCY: detached proofs cut billed infrastructure bytes to <= 40% of a TTL=delta CDN at the same staleness bound
     worst seed: 0.5051 (big-audience, seed 14)
EXPLORATORY PASS H2b-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: EFFICIENCY under stress: still <= 75% with 30 s mean sessions or 30% hostile peers
     worst seed: 0.7119 (adversarial, seed 20)
EXPLORATORY FAIL H2c-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: LATENCY: modelled p95 read latency <= 150 ms (no SLO bought with dropped requests)
     worst seed: 161.6109 (baseline, seed 19)
EXPLORATORY PASS H2d-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: USER COST: peer upload+control <= 16 MiB per reader-hour at 64 KiB payloads
     worst seed: 9.265 (big-audience, seed 24)
EXPLORATORY PASS H4b-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: WIN ZONE: modelled cost <= 70% of the TTL CDN once payload reaches 1 MiB per version
     worst seed: 0.6858 (heavy-payload, seed 14)
EXPLORATORY PASS H5-edgebg  EDGE-SERVED RENEWAL + BACKGROUND RENEWAL: NOT CLAIMED: Nodex does not reduce origin REQUESTS below a TTL=delta CDN (origin offload vs CDN is not the contribution)
     worst seed: 2.8978 (baseline, seed 8)
PASS H1a-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): SAFETY: zero admitted reads older than delta+eps (6 s), in every scenario incl. replay adversaries, lost invalidations, wrong clocks
     worst seed: 0 (baseline, seed 1)
PASS H1b-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): SAFETY: zero version rollbacks within a session
     worst seed: 0 (baseline, seed 1)
EXPLORATORY PASS H2a-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): EFFICIENCY: detached proofs cut billed infrastructure bytes to <= 40% of a TTL=delta CDN at the same staleness bound
     worst seed: 0.3876 (big-audience, seed 14)
EXPLORATORY PASS H2b-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): EFFICIENCY under stress: still <= 75% with 30 s mean sessions or 30% hostile peers
     worst seed: 0.63 (high-churn, seed 21)
EXPLORATORY FAIL H2c-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): LATENCY: modelled p95 read latency <= 150 ms (no SLO bought with dropped requests)
     worst seed: 151.6718 (baseline, seed 19)
EXPLORATORY PASS H2d-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): USER COST: peer upload+control <= 16 MiB per reader-hour at 64 KiB payloads
     worst seed: 9.9154 (big-audience, seed 24)
EXPLORATORY PASS H4a-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): KILL ZONE: at hypothetical prices Nodex costs MORE than the TTL CDN for <= 64 KiB snapshots, long tails and short sessions; it must self-disable there
     worst seed: 1.629 (long-tail, seed 25)
EXPLORATORY PASS H4b-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): WIN ZONE: modelled cost <= 70% of the TTL CDN once payload reaches 1 MiB per version
     worst seed: 0.5803 (heavy-payload, seed 23)
EXPLORATORY FAIL H5-shipped  AS SHIPPED (edge-served renewal + peer proof exchange): NOT CLAIMED: Nodex does not reduce origin REQUESTS below a TTL=delta CDN (origin offload vs CDN is not the contribution)
     worst seed: 0.8912 (baseline, seed 24)
```
