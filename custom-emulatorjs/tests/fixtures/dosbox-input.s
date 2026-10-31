.code16
.intel_syntax noprefix
.global _start
_start:
    push cs
    pop ds
    mov ax, 0x13
    int 0x10
    xor ax, ax
    int 0x33
    mov ax, 1
    int 0x33
loop:
    inc word ptr [ticks]
    mov ax, 3
    int 0x33
    mov word ptr [mouse_x], cx
    mov word ptr [mouse_y], dx
    mov ax, word ptr [buttons]
    xor ax, bx
    and ax, bx
    test ax, 1
    jz right
    inc word ptr [left_presses]
right:
    test ax, 2
    jz keys
    inc word ptr [right_presses]
keys:
    mov word ptr [buttons], bx
    mov ah, 1
    int 0x16
    jz wait
    xor ah, ah
    int 0x16
    inc word ptr [key_presses]
wait:
    mov ah, 0x86
    xor cx, cx
    mov dx, 10000
    int 0x15
    jmp loop
    .ascii "ROMM-DOS-MOUSE-STATE!"
ticks: .word 0
mouse_x: .word 0
mouse_y: .word 0
buttons: .word 0
left_presses: .word 0
right_presses: .word 0
key_presses: .word 0
