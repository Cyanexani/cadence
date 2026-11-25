import math, struct, wave, sys
def tone(path, seconds, hz, rate=8000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * hz * n / rate))) for n in range(int(seconds * rate))))
tone("a.wav", 3, 440)
tone("b.wav", 2, 660)
