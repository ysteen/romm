if (args.Length < 3 || args.Length > 5) return 1;
var (source, patch, output) = (args[0], args[1], args[2]);
var mode = args.Length >= 4 ? args[3] : "patch";
string format = args.Length == 5 ? args[4] : "cci";
string scratch = output + ".work";
try
{
    Directory.CreateDirectory(scratch);
    if (mode != "patch" && ArchivePatch.Extensions.Contains(Path.GetExtension(source).ToLowerInvariant()))
        source = ArchivePatch.Extract(source, Path.Combine(scratch, "source"), false, true);
    if (mode == "3ds-convert") await ThreeDs.Run(source, null, output, format);
    else
    {
        string selected = patch;
        if (ArchivePatch.Extensions.Contains(Path.GetExtension(patch).ToLowerInvariant()))
            selected = ArchivePatch.Extract(patch, Path.Combine(scratch, "patch"), mode != "patch");
        if (mode == "3ds-repack") await ThreeDs.Run(source, selected, output, format);
        else if (mode == "patch") await BinaryPatch.Apply(source, selected, output);
        else throw new InvalidDataException("Unknown operation");
    }
    if (new FileInfo(output).Length == 0) throw new InvalidDataException("Empty output");
    return 0;
}
catch (Exception error)
{
    File.Delete(output);
    Console.Error.WriteLine(error.Message);
    return 2;
}
finally { if (Directory.Exists(scratch)) Directory.Delete(scratch, true); }
