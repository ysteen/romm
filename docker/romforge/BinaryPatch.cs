using System.Buffers.Binary;
using System.Diagnostics;
using Patch.Core.Formats;

internal static class BinaryPatch
{
public static async Task Apply(string source,string patch,string output)
{
    byte[] header = new byte[8];
    using (var input = File.OpenRead(patch))
        input.ReadExactly(header);
    string magic = System.Text.Encoding.ASCII.GetString(header);
    if (header[0] == 0xd6 && header[1] == 0xc3 && header[2] == 0xc4)
    {
        // Linux xdelta3 avoids the Windows-specific P/Invoke ABI.
        var start = new ProcessStartInfo("xdelta3") { UseShellExecute = false };
        foreach (var arg in new[] { "-d", "-D", "-R", "-s", source, patch, output })
            start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("Cannot start xdelta3");
        await process.WaitForExitAsync();
        if (process.ExitCode != 0) throw new InvalidDataException("xdelta3 rejected the patch");
    }
    else if (magic.StartsWith("IPS32")) await Ips32.ApplyPatchAsync(source, patch, output);
    else if (magic.StartsWith("PATCH")) await Ips.ApplyPatchAsync(source, patch, output);
    else if (magic.StartsWith("BPS1"))
    {
        // The upstream BPS decoder checks sizes but does not verify its CRC trailer.
        byte[] trailer = new byte[12];
        using (var input = File.OpenRead(patch))
        {
            input.Seek(-12, SeekOrigin.End);
            input.ReadExactly(trailer);
        }
        CheckCrc(source, BinaryPrimitives.ReadUInt32LittleEndian(trailer));
        CheckCrc(patch, BinaryPrimitives.ReadUInt32LittleEndian(trailer.AsSpan(8)), 4);
        await Bps.ApplyPatchAsync(source, patch, output);
        CheckCrc(output, BinaryPrimitives.ReadUInt32LittleEndian(trailer.AsSpan(4)));
    }
    else if (magic.StartsWith("UPS1")) await Ups.ApplyPatchAsync(source, patch, output);
    else if (magic.StartsWith("APS1")) await Aps.ApplyPatchAsync(source, patch, output);
    else if (magic.StartsWith("PPF")) await Ppf.ApplyPatchAsync(source, patch, output);
    else throw new InvalidDataException("Unsupported patch signature");
}
static void CheckCrc(string path, uint expected, int exclude = 0)
{
    using var input = File.OpenRead(path);
    long remaining = input.Length - exclude;
    uint crc = 0xffffffff;
    byte[] buffer = new byte[65536];
    while (remaining > 0)
    {
        int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
        if (read == 0) throw new EndOfStreamException();
        for (int i = 0; i < read; i++)
        {
            crc ^= buffer[i];
            for (int bit = 0; bit < 8; bit++)
                crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0);
        }
        remaining -= read;
    }
    if (~crc != expected) throw new InvalidDataException("CRC32 mismatch");
}

}
