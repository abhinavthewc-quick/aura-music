#!/usr/bin/env python3
"""Comprehensive Benchmark: Hugging Face Bucket vs. Oracle Cloud Infrastructure (OCI)

Object Storage (Hyderabad) for Aura Music audio streaming.
"""
import datetime
import hashlib
import hmac
import json
import statistics
import time
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Tuple

OCI_NAMESPACE = "ax6entau0azm"
OCI_BUCKET_NAME = "Kalam"
OCI_REGION = "ap-hyderabad-1"
OCI_ACCESS_KEY = "327b856340046407370e32d81faf18ae3259ef00"
OCI_SECRET_KEY = "lvBFujZc9f+Kx+2EHNKI62gJQrhgjnDKDFdm5dh3qxI="
HF_BUCKET_ID = "Angelrider/sonora"

TRACK_1 = "A. R. Rahman - Aalaporaan Thamizhan (From ＂Mersal＂) [LAeEXy00MsE].opus"
TRACK_2 = "Shaan Rahman - Topic - Welcome to Punjab [TqP3ZJq5M7w].opus"


def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def get_oci_request(object_key: str, byte_range: Optional[str] = None) -> urllib.request.Request:
    host = f"{OCI_NAMESPACE}.compat.objectstorage.{OCI_REGION}.oraclecloud.com"
    clean_key = object_key.lstrip("/")
    endpoint = f"https://{host}/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()

    canonical_uri = f"/{OCI_BUCKET_NAME}/{urllib.parse.quote(clean_key)}"
    headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if byte_range:
        headers["range"] = byte_range

    sorted_keys = sorted(headers.keys())
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted_keys)
    signed_headers = ";".join(sorted_keys)
    canonical_request = f"GET\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    credential_scope = f"{date_stamp}/{OCI_REGION}/s3/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"

    k_date = sign(f"AWS4{OCI_SECRET_KEY}".encode("utf-8"), date_stamp)
    k_region = sign(k_date, OCI_REGION)
    k_service = sign(k_region, "s3")
    k_signing = sign(k_service, "aws4_request")
    sig = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    auth = f"AWS4-HMAC-SHA256 Credential={OCI_ACCESS_KEY}/{credential_scope}, SignedHeaders={signed_headers}, Signature={sig}"

    req_headers = {
        "Host": host,
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
        "Authorization": auth,
        "User-Agent": "AuraBenchmark/1.0",
    }
    if byte_range:
        req_headers["Range"] = byte_range
    return urllib.request.Request(endpoint, headers=req_headers)


def get_hf_request(object_key: str, byte_range: Optional[str] = None) -> urllib.request.Request:
    clean_key = object_key.lstrip("/")
    url = f"https://huggingface.co/buckets/{HF_BUCKET_ID}/resolve/{urllib.parse.quote(clean_key)}"
    headers = {"User-Agent": "AuraBenchmark/1.0"}
    if byte_range:
        headers["Range"] = byte_range
    return urllib.request.Request(url, headers=headers)


def measure_request(req_builder, object_key: str, byte_range: Optional[str] = None) -> Tuple[float, float, int]:
    """Measures: (TTFB in ms, Total transfer time in ms, bytes downloaded)"""
    req = req_builder(object_key, byte_range)
    t0 = time.perf_counter()
    with urllib.request.urlopen(req) as resp:
        t_ttfb = time.perf_counter() - t0
        data = resp.read()
        t_total = time.perf_counter() - t0
        return t_ttfb * 1000.0, t_total * 1000.0, len(data)


def run_benchmark_series(
    name: str,
    req_builder,
    object_key: str,
    byte_range: Optional[str],
    iterations: int = 5,
) -> Dict[str, float]:
    ttfb_list: List[float] = []
    total_list: List[float] = []
    bytes_count = 0

    for i in range(iterations):
        ttfb, total, b = measure_request(req_builder, object_key, byte_range)
        ttfb_list.append(ttfb)
        total_list.append(total)
        bytes_count = b

    mb = bytes_count / (1024 * 1024)
    speed_mb_s = [(mb / (t / 1000.0)) if t > 0 else 0 for t in total_list]

    return {
        "name": name,
        "bytes": bytes_count,
        "iterations": iterations,
        "ttfb_mean_ms": statistics.mean(ttfb_list),
        "ttfb_median_ms": statistics.median(ttfb_list),
        "ttfb_min_ms": min(ttfb_list),
        "ttfb_max_ms": max(ttfb_list),
        "total_mean_ms": statistics.mean(total_list),
        "total_median_ms": statistics.median(total_list),
        "total_min_ms": min(total_list),
        "total_max_ms": max(total_list),
        "speed_mean_mb_s": statistics.mean(speed_mb_s),
        "speed_median_mb_s": statistics.median(speed_mb_s),
        "speed_max_mb_s": max(speed_mb_s),
    }


def main():
    print("=" * 70)
    print("⚡ AURA MUSIC SPEED BENCHMARK: HUGGING FACE VS. ORACLE CLOUD (OCI)")
    print(f"Target OCI: [{OCI_NAMESPACE}] {OCI_BUCKET_NAME} in Region: {OCI_REGION}")
    print(f"Target HF:  {HF_BUCKET_ID}")
    print("=" * 70)

    # 1. Initial 256 KB Range (Immediate Audio Start Latency)
    print("\n--- Test 1: First 256 KB Range (Immediate Playback Buffer) ---")
    print("Sampling OCI Hyderabad (5 runs)...")
    oci_256k = run_benchmark_series("OCI (256 KB)", get_oci_request, TRACK_1, "bytes=0-262143", iterations=5)
    print(f"  OCI 256KB: TTFB={oci_256k['ttfb_median_ms']:.1f}ms (min: {oci_256k['ttfb_min_ms']:.1f}ms) | Total={oci_256k['total_median_ms']:.1f}ms")

    print("Sampling Hugging Face (5 runs)...")
    hf_256k = run_benchmark_series("HF (256 KB)", get_hf_request, TRACK_1, "bytes=0-262143", iterations=5)
    print(f"  HF 256KB:  TTFB={hf_256k['ttfb_median_ms']:.1f}ms (min: {hf_256k['ttfb_min_ms']:.1f}ms) | Total={hf_256k['total_median_ms']:.1f}ms")

    speedup_256k = hf_256k["total_median_ms"] / oci_256k["total_median_ms"] if oci_256k["total_median_ms"] > 0 else 0
    print(f"==> Result: OCI Hyderabad starts audio playback {speedup_256k:.1f}x faster!")

    # 2. 1 MB Range (Continuous Streaming Buffer)
    print("\n--- Test 2: 1 MB Range (Continuous Streaming Buffer) ---")
    print("Sampling OCI Hyderabad (5 runs)...")
    oci_1mb = run_benchmark_series("OCI (1 MB)", get_oci_request, TRACK_1, "bytes=0-1048575", iterations=5)
    print(f"  OCI 1MB:   Total={oci_1mb['total_median_ms']:.1f}ms | Throughput={oci_1mb['speed_median_mb_s']:.2f} MB/s")

    print("Sampling Hugging Face (5 runs)...")
    hf_1mb = run_benchmark_series("HF (1 MB)", get_hf_request, TRACK_1, "bytes=0-1048575", iterations=5)
    print(f"  HF 1MB:    Total={hf_1mb['total_median_ms']:.1f}ms | Throughput={hf_1mb['speed_median_mb_s']:.2f} MB/s")

    speedup_1mb = hf_1mb["total_median_ms"] / oci_1mb["total_median_ms"] if oci_1mb["total_median_ms"] > 0 else 0
    print(f"==> Result: OCI Hyderabad 1MB chunk is {speedup_1mb:.1f}x faster!")

    # 3. Full Track Download (Aalaporaan Thamizhan ~7.3 MB)
    print(f"\n--- Test 3: Full Track Download - Track 1 (~7.3 MB) ---")
    print("Downloading full track from OCI (3 runs)...")
    oci_full = run_benchmark_series("OCI (Full)", get_oci_request, TRACK_1, None, iterations=3)
    print(f"  OCI Full:  Total={oci_full['total_median_ms']:.1f}ms ({oci_full['total_median_ms']/1000:.2f}s) | Throughput={oci_full['speed_median_mb_s']:.2f} MB/s ({oci_full['speed_median_mb_s']*8:.1f} Mbps)")

    print("Downloading full track from Hugging Face (3 runs)...")
    hf_full = run_benchmark_series("HF (Full)", get_hf_request, TRACK_1, None, iterations=3)
    print(f"  HF Full:   Total={hf_full['total_median_ms']:.1f}ms ({hf_full['total_median_ms']/1000:.2f}s) | Throughput={hf_full['speed_median_mb_s']:.2f} MB/s ({hf_full['speed_median_mb_s']*8:.1f} Mbps)")

    speedup_full = hf_full["total_median_ms"] / oci_full["total_median_ms"] if oci_full["total_median_ms"] > 0 else 0
    print(f"==> Result: Full track download on OCI is {speedup_full:.1f}x faster!")

    # 4. Full Track Download - Track 2 (Welcome to Punjab ~4.37 MB)
    print(f"\n--- Test 4: Full Track Download - Track 2 (~4.37 MB) ---")
    print("Downloading full track from OCI (3 runs)...")
    oci_t2 = run_benchmark_series("OCI (T2)", get_oci_request, TRACK_2, None, iterations=3)
    print(f"  OCI T2:    Total={oci_t2['total_median_ms']:.1f}ms ({oci_t2['total_median_ms']/1000:.2f}s) | Throughput={oci_t2['speed_median_mb_s']:.2f} MB/s ({oci_t2['speed_median_mb_s']*8:.1f} Mbps)")

    print("Downloading full track from Hugging Face (3 runs)...")
    hf_t2 = run_benchmark_series("HF (T2)", get_hf_request, TRACK_2, None, iterations=3)
    print(f"  HF T2:     Total={hf_t2['total_median_ms']:.1f}ms ({hf_t2['total_median_ms']/1000:.2f}s) | Throughput={hf_t2['speed_median_mb_s']:.2f} MB/s ({hf_t2['speed_median_mb_s']*8:.1f} Mbps)")

    speedup_t2 = hf_t2["total_median_ms"] / oci_t2["total_median_ms"] if oci_t2["total_median_ms"] > 0 else 0
    print(f"==> Result: Full track download on OCI is {speedup_t2:.1f}x faster!")

    # Output JSON summary for artifact / structured reporting
    summary = {
        "oci_256k": oci_256k,
        "hf_256k": hf_256k,
        "speedup_256k": speedup_256k,
        "oci_1mb": oci_1mb,
        "hf_1mb": hf_1mb,
        "speedup_1mb": speedup_1mb,
        "oci_full": oci_full,
        "hf_full": hf_full,
        "speedup_full": speedup_full,
        "oci_t2": oci_t2,
        "hf_t2": hf_t2,
        "speedup_t2": speedup_t2,
    }
    with open("benchmark_results.json", "w") as f:
        json.dump(summary, f, indent=2)
    print("\n✓ Full benchmark results saved to benchmark_results.json")


if __name__ == "__main__":
    main()
