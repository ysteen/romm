using Common;
namespace Patch.Core;

public static class UniversalPatcher
{
    public static async Task<byte[]> ApplyPatchAsync(byte[] source, byte[] patch, IProgress<ProgressInfo>? progress = null, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        string dir = Path.Combine(Path.GetTempPath(), "romforge-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string src = Path.Combine(dir, "source"), diff = Path.Combine(dir, "patch"), output = Path.Combine(dir, "output");
            await File.WriteAllBytesAsync(src, source, ct);
            await File.WriteAllBytesAsync(diff, patch, ct);
            await BinaryPatch.Apply(src, diff, output);
            return await File.ReadAllBytesAsync(output, ct);
        }
        finally { Directory.Delete(dir, true); }
    }
}
